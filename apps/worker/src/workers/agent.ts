import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@finance/shared";
// The grounding gate lives with the recap because that is where it was first
// needed; it is not recap-specific and the agent is held to the same rule.
import { verifyGrounding, verifyAccountReferences } from "@finance/shared/src/recap";
import { attributionFrom, attributionMonthOf, isShiftableIncome } from "@finance/shared";
import {
  alpacaConfigured,
  checkGuardrails,
  getAccount,
  lastPrice,
  listPositions,
  validateTradeProposal,
  type ExecutionMode,
  type GuardrailConfig,
} from "@finance/shared";
import { spentToday } from "./executor.js";

// Agent worker (spec Phase 2 §8 prompt contract, extended for Phase 3a):
// assembles a derived financial snapshot, calls Claude, and writes
// recommendations. Alerts are advisory and carry no payload. `trade` proposals
// carry one — but only when the owner has turned every one of the switches in
// `resolveTradeCapability` on, and even then this worker never places an order:
// it writes a row, the owner approves it, and the executor re-decides in code.
//
// Account identifiers are masked to last-4 before anything reaches the model,
// and the model never picks the account a trade lands in — code stamps in the
// single account the owner flagged agent-controlled.

// Default model for analysis runs; per-function model selection from the UI
// is on the roadmap — until then, override via AGENT_MODEL in .env.
const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5";

const TradeActionSchema = z.object({
  symbol: z.string().describe("Ticker exactly as the broker lists it, e.g. VOO"),
  side: z.enum(["buy", "sell"]),
  notional: z
    .number()
    .nullable()
    .describe("Order size in dollars. Set this or qty, never both."),
  qty: z
    .number()
    .nullable()
    .describe("Order size in shares. Required if you set a limit price."),
  limit_price: z
    .number()
    .nullable()
    .describe("Optional limit price. Requires qty; illegal with notional."),
  time_in_force: z
    .enum(["day", "gtc"])
    .describe('"day" unless the order must survive the session; a dollar order is always day'),
});

const baseFields = {
  summary: z.string().describe("One plain-English sentence"),
  rationale: z
    .string()
    .describe("References the specific numbers from the snapshot driving this"),
  confidence: z.number().describe("0 to 1"),
  expires_in_days: z
    .number()
    .describe("How many days this recommendation stays relevant, 1-30"),
};

/**
 * The output schema is narrowed to what the owner has actually enabled. When
 * trading is off the model is not given the vocabulary to propose a trade at
 * all — a rule it cannot express is a rule it cannot break, and that is worth
 * more than a rule in the prompt telling it not to.
 */
function outputSchemaFor(tradesAllowed: boolean) {
  const rec = tradesAllowed
    ? z.object({
        type: z.enum(["alert", "trade"]),
        ...baseFields,
        trade: TradeActionSchema.nullable().describe(
          "Required when type is trade. Null for an alert."
        ),
      })
    : z.object({ type: z.enum(["alert"]), ...baseFields });
  return z.object({
    recommendations: z
      .array(rec)
      .describe("Zero to five recommendations; only ones truly worth attention"),
  });
}

interface ParsedRec {
  type: "alert" | "trade";
  summary: string;
  rationale: string;
  confidence: number;
  expires_in_days: number;
  trade?: z.infer<typeof TradeActionSchema> | null;
}

const SYSTEM_PROMPT = `You are the analysis engine of a self-hosted personal finance platform serving exactly one user, its owner. You produce advisory recommendations only — nothing you output is executed; a human reads each one and acknowledges it.

Rules:
- Every number you write must appear verbatim in the snapshot. Do not add, subtract, average or round figures together — not even correctly. This is checked after the fact and a single unsourced figure discards the entire run, so if you want a total, use one from \`totals\`; if the total you want isn't there, describe the parts instead.
- Only surface recommendations that are genuinely worth the owner's attention: unusual spend, credit utilization risks, upcoming recurring charges that look wrong, cash-flow trends, idle cash, subscription anomalies. Zero recommendations is a valid answer.
- The owner has seen your last recommendations and their outcomes (provided). Do not repeat rejected or recently-made recommendations without new supporting data.
- Refer to an account only by its exact \`label\` from the snapshot. Never pair an account name with a last-four yourself: several accounts share a name and differ only by mask, so a name you assemble is a different account from the one you meant. This is checked, and a mismatch discards the run.
- Amounts follow the snapshot's convention: positive transaction amounts are outflows.`;

const ADVISORY_ONLY = `
- Execution is off. Never propose specific trades or transfers — frame every finding as an alert.`;

const TRADING_ENABLED = `
- Execution is on for trades, against the single brokerage account described in \`broker\`. Nothing else is executable: a finding about spending, cash flow or credit is still an alert.
- A \`trade\` recommendation must carry a \`trade\` object and an alert must not. The order you propose is your own number and does not have to appear in the snapshot — but every figure in your summary and rationale still does, including any you use to justify the size.
- Size the order in dollars (\`notional\`) or in shares (\`qty\`), never both. A \`limit_price\` requires \`qty\`; a dollar-denominated order is a market order good for the day.
- Sell only a symbol that appears in \`broker.positions\`, and never more than the quantity shown there.
- Stay inside \`guardrails\`: the per-order cap, what is left of today's cap, the per-position cap measured against any position you already hold, and the open-position count. A proposal that breaches one is discarded before the owner ever sees it, so proposing it costs you the recommendation.
- Do not choose an account. There is exactly one and it is filled in for you.
- Every trade still waits for the owner to approve it, and is re-checked against these same limits at the moment it would execute.`;

interface BrokerPosition {
  symbol: string;
  qty: number;
  market_value: number;
}

/**
 * Whether the agent may propose a trade at all, and everything it needs to
 * propose a sane one. Every field is derived here so that neither the prompt
 * nor the model has any say in it.
 */
interface TradeCapability {
  enabled: boolean;
  /** Why not, when it is off — logged, so a silent "no trades" is explicable. */
  reason: string | null;
  mode: ExecutionMode;
  accountId: string | null;
  cfg: GuardrailConfig | null;
  positions: BrokerPosition[];
  spentToday: number;
  /** Goes into the snapshot verbatim; null when trading is off. */
  broker: Record<string, unknown> | null;
}

const tradingOff = (reason: string): TradeCapability => ({
  enabled: false,
  reason,
  mode: "paper",
  accountId: null,
  cfg: null,
  positions: [],
  spentToday: 0,
  broker: null,
});

/**
 * Every switch that has to be on before the agent proposes an order, checked
 * against the world rather than asserted. A fresh install fails the first one
 * and keeps failing them, which is the intent: trading is opt-in at four
 * independent points, and turning on three of them does nothing.
 */
export async function resolveTradeCapability(
  db: SupabaseClient,
  cfgRow: Record<string, unknown> | null
): Promise<TradeCapability> {
  if (!cfgRow) return tradingOff("no agent_config row");

  const cfg: GuardrailConfig = {
    autonomy_level: Number(cfgRow.autonomy_level ?? 0),
    max_txn_amount: Number(cfgRow.max_txn_amount ?? 0),
    max_daily_amount: Number(cfgRow.max_daily_amount ?? 0),
    max_open_positions: Number(cfgRow.max_open_positions ?? 0),
    max_position_size: Number(cfgRow.max_position_size ?? 0),
    allowed_action_types: (cfgRow.allowed_action_types as string[]) ?? [],
  };

  // Level 0 is read-only; 1 is the first level at which recommending an action
  // is meant to happen at all. Execution needs 2, and is the executor's to
  // enforce — a level-1 owner should still get proposals to look at.
  if (cfg.autonomy_level < 1) {
    return tradingOff(`autonomy level ${cfg.autonomy_level} is analysis-only`);
  }
  if (!cfg.allowed_action_types.includes("trade")) {
    return tradingOff("trade is not in allowed_action_types");
  }
  if (!alpacaConfigured()) {
    return tradingOff("Alpaca is not configured (ALPACA_KEY_ID / ALPACA_SECRET_KEY)");
  }

  const mode: ExecutionMode = cfgRow.execution_mode === "live" ? "live" : "paper";

  // The agent must never choose between accounts — that is the one decision
  // where a plausible-looking mistake moves real money into the wrong place.
  // Exactly one flagged account, or no trading.
  const { data: accts } = await db
    .from("accounts")
    .select("id, name, mask, type")
    .eq("is_agent_controlled", true);
  if (!accts?.length) return tradingOff("no account is flagged agent-controlled");
  if (accts.length > 1) {
    return tradingOff(
      `${accts.length} accounts are flagged agent-controlled — the agent must not pick between them`
    );
  }
  const acct = accts[0];

  try {
    const [account, positions] = await Promise.all([getAccount(mode), listPositions(mode)]);
    if (account.status !== "ACTIVE") {
      return tradingOff(`broker account status is ${account.status}, not ACTIVE`);
    }
    const held: BrokerPosition[] = positions.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      market_value: Number(p.market_value),
    }));
    const spent = await spentToday(db);
    return {
      enabled: true,
      reason: null,
      mode,
      accountId: acct.id as string,
      cfg,
      positions: held,
      spentToday: spent,
      broker: {
        mode,
        account_label: `${acct.name} \u2025${acct.mask ?? "????"}`,
        cash: Number(account.cash),
        buying_power: Number(account.buying_power),
        equity: Number(account.equity),
        positions: positions.map((p) => ({
          symbol: p.symbol,
          qty: Number(p.qty),
          market_value: Number(p.market_value),
          cost_basis: Number(p.cost_basis),
          unrealized_pl: Number(p.unrealized_pl),
        })),
      },
    };
  } catch (e: unknown) {
    // An unknown broker state is not an empty one. Without positions the
    // per-position and open-position caps cannot be measured, so there is
    // nothing to propose against.
    return tradingOff(`broker unreachable: ${(e as Error).message}`);
  }
}

interface SnapshotResult {
  snapshot: Record<string, unknown>;
  maskedAccounts: number;
  trade: TradeCapability;
}

async function buildSnapshot(db: SupabaseClient): Promise<SnapshotResult> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000)
    .toISOString()
    .slice(0, 10);

  const [
    { data: accounts },
    { data: txns },
    { data: recurring },
    { data: holdings },
    { data: liabilities },
    { data: goals },
    { data: config },
    { data: lastRecs },
    { data: netWorth },
    { data: settingsRow },
  ] = await Promise.all([
    db.from("accounts").select("name, type, subtype, mask, current_balance, is_business, business_entity"),
    db
      .from("transactions")
      .select("date, amount, merchant_clean, merchant, is_business, categories (name, category_groups (type)), accounts (mask, type)")
      .gte("date", ninetyDaysAgo)
      // hidden=false alone counts each dollar once: a split hides the parent
      // and creates children. Excluding children too would understate spending.
      .eq("hidden", false)
      .order("date", { ascending: false })
      .limit(1500),
    db.from("recurring_items").select("merchant, cadence, expected_amount, next_expected_date, status, is_subscription").neq("status", "cancelled"),
    db.from("holdings").select("symbol, quantity, cost_basis, market_value"),
    db.from("liabilities").select("type, apr, minimum_payment, next_due_date, balance, accounts (mask)"),
    db.from("goals").select("name, type, target_amount, current_amount, target_date, cadence_amount, cadence, priority, status"),
    db.from("agent_config").select("*").eq("id", 1).maybeSingle(),
    db
      .from("recommendations")
      .select("created_at, type, summary, status")
      .order("created_at", { ascending: false })
      .limit(10),
    db.from("net_worth_snapshots").select("date, total").order("date", { ascending: false }).limit(30),
    db
      .from("app_settings")
      .select("income_attribution, income_shift_from_day")
      .eq("id", 1)
      .maybeSingle(),
  ]);

  // 90-day cash flow aggregates by month and category.
  //
  // Transfers are excluded, because a transfer is the same dollar counted
  // twice: moving $6,500 from savings to checking is an outflow on one account
  // and an inflow on the other, and a card payment is an outflow from checking
  // and an inflow on the card. Counting them made June read as $15,900 in
  // against $18,300 out — a $2,180 shortfall in a month that was actually
  // $2,310 positive — and the agent duly reported three straight negative
  // months. Reports and the recap already excluded them; only this snapshot
  // did not.
  // Month-end pay counts toward the month it funds when the owner has said so.
  // Budget and Reports both honour this; a snapshot that did not would have the
  // agent reasoning about a different July than the pages the owner is reading.
  const attribution = attributionFrom(settingsRow ?? null);

  const monthly = new Map<string, { inflow: number; outflow: number; transfers: number }>();
  const byCategory = new Map<string, number>();
  for (const t of txns ?? []) {
    const amt = Number(t.amount);
    const cat = t.categories as unknown as
      | { name: string; category_groups?: { type: string } | null }
      | null;
    const isIncome = cat?.category_groups?.type === "income" || (!cat && amt < 0);
    const month = attributionMonthOf(
      String(t.date),
      isIncome && isShiftableIncome(cat?.name),
      attribution
    );
    if (!monthly.has(month)) monthly.set(month, { inflow: 0, outflow: 0, transfers: 0 });
    if (cat?.category_groups?.type === "transfer") {
      monthly.get(month)!.transfers += Math.abs(amt);
      continue;
    }
    if (amt > 0) {
      monthly.get(month)!.outflow += amt;
      byCategory.set(cat?.name ?? "Uncategorized", (byCategory.get(cat?.name ?? "Uncategorized") ?? 0) + amt);
    } else {
      monthly.get(month)!.inflow += -amt;
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100;

  const trade = await resolveTradeCapability(db, config ?? null);
  if (!trade.enabled) console.log(`[agent] trade proposals off: ${trade.reason}`);

  // Totals the model would otherwise have to add up itself. It is not allowed
  // to — every figure it cites has to come from here — and its first real run
  // was rejected for saying "roughly $9,400 across nine cards", which was
  // correct arithmetic and still a rule violation. The fix is to do the sum,
  // not to relax the rule.
  const accountRows = accounts ?? [];
  const sumBalances = (pred: (a: (typeof accountRows)[number]) => boolean) =>
    round(accountRows.filter(pred).reduce((s, a) => s + Number(a.current_balance ?? 0), 0));
  const totals = {
    liquid: sumBalances((a) => a.type === "depository"),
    credit_balances: sumBalances((a) => a.type === "credit"),
    loan_balances: sumBalances((a) => a.type === "loan"),
    investment: sumBalances((a) => a.type === "investment"),
    credit_card_count: accountRows.filter((a) => a.type === "credit").length,
    credit_cards_with_balance: accountRows.filter(
      (a) => a.type === "credit" && Number(a.current_balance ?? 0) > 0
    ).length,
  };

  const snapshot = {
    as_of: new Date().toISOString().slice(0, 10),
    totals,
    // masked: name + last-4 only, never full identifiers (spec §7.7)
    accounts: (accounts ?? []).map((a) => ({
      // One pre-joined string to quote, because pairing a name with a mask is
      // a step the model gets wrong and does not need to take: three cards read
      // "Quicksilver" and three read "CREDIT CARD", so the mask is the only
      // thing that identifies them and it must travel with the name.
      label: `${a.name} ‥${a.mask ?? "????"}`,
      name: a.name,
      last4: a.mask,
      type: a.type,
      subtype: a.subtype,
      balance: a.current_balance,
      business: a.is_business ? a.business_entity ?? true : false,
    })),
    net_worth_recent: (netWorth ?? []).map((n) => ({ date: n.date, total: n.total })),
    cash_flow_by_month: [...monthly.entries()]
      .sort()
      .map(([month, v]) => ({
        month,
        inflow: round(v.inflow),
        outflow: round(v.outflow),
        net: round(v.inflow - v.outflow),
        // Reported separately so the model can talk about money moving without
        // mistaking it for income or spending.
        transfers_excluded: round(v.transfers),
      })),
    spend_by_category_90d: [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([category, total]) => ({ category, total: round(total) })),
    largest_recent_transactions: (txns ?? [])
      .filter((t) => Number(t.amount) > 0)
      .slice(0, 200)
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 15)
      .map((t) => ({
        date: t.date,
        merchant: t.merchant_clean ?? t.merchant,
        amount: t.amount,
        account_last4: (t.accounts as unknown as { mask: string | null } | null)?.mask,
      })),
    recurring: recurring ?? [],
    holdings: holdings ?? [],
    liabilities: (liabilities ?? []).map((l) => ({
      type: l.type,
      apr: l.apr,
      minimum_payment: l.minimum_payment,
      next_due_date: l.next_due_date,
      balance: l.balance,
      account_last4: (l.accounts as unknown as { mask: string | null } | null)?.mask,
    })),
    goals: goals ?? [],
    guardrails: config
      ? {
          autonomy_level: config.autonomy_level,
          max_txn_amount: config.max_txn_amount,
          max_daily_amount: config.max_daily_amount,
          // Only meaningful once there is something to execute, and only
          // honest once the model can see the whole limit — a per-order cap
          // with no position cap beside it invites a proposal that clears one
          // and dies on the other.
          ...(trade.enabled
            ? {
                max_open_positions: trade.cfg!.max_open_positions,
                max_position_size: trade.cfg!.max_position_size,
                allowed_action_types: trade.cfg!.allowed_action_types,
                execution_mode: trade.mode,
                spent_today: round(trade.spentToday),
                remaining_today: round(
                  Math.max(0, trade.cfg!.max_daily_amount - trade.spentToday)
                ),
              }
            : {}),
        }
      : null,
    broker: trade.broker,
    last_recommendations: lastRecs ?? [],
  };

  return { snapshot, maskedAccounts: accounts?.length ?? 0, trade };
}

/**
 * Turn a model-proposed trade into a payload the executor could act on, or say
 * why it could not.
 *
 * Prices the order first, because a cap in dollars cannot be enforced against a
 * number of shares, then runs the *same* guardrail function the executor runs.
 * The two inputs that describe the moment of execution rather than the trade —
 * approval status and the autonomy level — are answered hypothetically here:
 * the question this pass asks is "if the owner approved this and execution were
 * on, would it clear?", and a proposal is worth showing exactly when the answer
 * is yes. The real answers are supplied by the executor, later, in code.
 */
export async function shapeTradeProposal(
  rec: ParsedRec,
  trade: TradeCapability
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; problems: string[] }> {
  if (!trade.enabled || !trade.cfg || !trade.accountId) {
    return { ok: false, problems: [`trade proposals are off: ${trade.reason}`] };
  }
  if (!rec.trade) {
    return { ok: false, problems: ["recommendation is typed trade but carries no order"] };
  }

  const shaped = validateTradeProposal(rec.trade);
  if (!shaped.ok) return { ok: false, problems: shaped.problems };
  const { symbol, side, notional, qty, limit_price, time_in_force } = shaped.proposal;

  let price: number | null = null;
  let amount = notional ?? Number.NaN;
  if (qty) {
    price = await lastPrice(trade.mode, symbol);
    if (price == null) {
      return { ok: false, problems: [`no price available for ${symbol}, so the order cannot be sized`] };
    }
    amount = Math.round(qty * price * 100) / 100;
  }

  const held = trade.positions.find((p) => p.symbol === symbol);
  const expiresAt = new Date(Date.now() + rec.expires_in_days * 86400_000).toISOString();

  const verdict = checkGuardrails(
    { type: "trade", symbol, side, amount, account_id: trade.accountId },
    // Hypothetical autonomy: see the note above. Every other limit is the
    // owner's real one, unmodified.
    { ...trade.cfg, autonomy_level: Math.max(trade.cfg.autonomy_level, 2) },
    {
      now: new Date(),
      status: "approved",
      expires_at: expiresAt,
      spent_today: trade.spentToday,
      open_positions: trade.positions.length,
      already_held: !!held,
      position_value: held?.market_value ?? 0,
      position_qty: held?.qty ?? 0,
      account_is_agent_controlled: true,
    }
  );
  if (!verdict.ok) return { ok: false, problems: verdict.violations };

  return {
    ok: true,
    payload: {
      symbol,
      side,
      notional,
      qty,
      limit_price,
      time_in_force,
      // Code's decision, never the model's — there is exactly one eligible
      // account and it was resolved from the database.
      account_id: trade.accountId,
      // What the proposal was worth when it was made. The executor re-prices;
      // this is here so the owner can see what they are approving and so a
      // stale approval is visibly stale.
      amount,
      price_used: price,
      priced_at: new Date().toISOString(),
      mode: trade.mode,
    },
  };
}

export async function runAgentAnalysis(
  db: SupabaseClient,
  trigger: "cron" | "manual"
): Promise<void> {
  const { snapshot, trade } = await buildSnapshot(db);

  const { data: run, error: runErr } = await db
    .from("agent_runs")
    .insert({ trigger, input_snapshot: snapshot, model: MODEL, status: "running" })
    .select("id")
    .single();
  if (runErr || !run) {
    console.error("[agent] could not create run row:", runErr?.message);
    return;
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: "medium",
        format: zodOutputFormat(outputSchemaFor(trade.enabled)),
      },
      system: SYSTEM_PROMPT + (trade.enabled ? TRADING_ENABLED : ADVISORY_ONLY),
      messages: [
        {
          role: "user",
          content: `Here is the current financial snapshot as JSON. Analyze it and return your recommendations.\n\n${JSON.stringify(snapshot)}`,
        },
      ],
    });

    const tokensUsed =
      (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      // Malformed or refused output is rejected and logged, never displayed raw.
      await db
        .from("agent_runs")
        .update({
          finished_at: new Date().toISOString(),
          tokens_used: tokensUsed,
          status: "failed",
          error:
            response.stop_reason === "refusal"
              ? "model refusal"
              : "output failed schema validation",
        })
        .eq("id", run.id);
      return;
    }

    const recs = (response.parsed_output as { recommendations: ParsedRec[] }).recommendations.filter(
      (r) => r.confidence >= 0 && r.confidence <= 1 && r.expires_in_days >= 1 && r.expires_in_days <= 30
    );

    // Shape and pre-judge every trade proposal before the owner sees it. The
    // executor re-checks all of this at execution time against a world that
    // will have moved; this pass exists so the queue only ever offers an
    // Approve button on something that could actually go through. A proposal
    // that cannot is dropped and recorded in the audit log rather than
    // presented as a decision the owner gets to make and then loses.
    const accepted: { rec: ParsedRec; payload: Record<string, unknown> | null }[] = [];
    const discarded: { summary: string; problems: string[] }[] = [];

    for (const rec of recs) {
      if (rec.type !== "trade") {
        // An alert never carries a payload, whatever the model attached.
        accepted.push({ rec, payload: null });
        continue;
      }
      const shaped = await shapeTradeProposal(rec, trade);
      if (!shaped.ok) {
        discarded.push({ summary: rec.summary, problems: shaped.problems });
        continue;
      }
      accepted.push({ rec, payload: shaped.payload });
    }

    if (discarded.length) {
      await audit(db, "agent", "trade_proposals_discarded", "agent_runs", run.id, {
        discarded,
      });
      for (const d of discarded) {
        console.error(`[agent] discarded trade: ${d.problems.join("; ")}`);
      }
    }

    // The system prompt asks the model to cite only snapshot figures. Asking is
    // not a guarantee, and the recap already proves the check is cheap — so the
    // agent is held to the same standard its narrative sibling is. A single
    // unsourced number fails the run: nothing is written, because an advisory
    // that quotes a balance you don't have is worse than no advisory.
    //
    // A proposed order size is the one exception, and it is not a loophole: it
    // is the model's own proposal about the future, not a claim about the
    // owner's finances, and it is judged in dollars by the guardrails rather
    // than by whether it appears in a snapshot of the past.
    const texts = accepted.flatMap(({ rec }) => [rec.summary, rec.rationale]);
    const proposedFigures = accepted
      .flatMap(({ payload }) =>
        payload
          ? [payload.notional, payload.qty, payload.limit_price, payload.amount]
          : []
      )
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));

    // Right number, wrong card is still wrong. Checked separately because
    // grounding has nothing to say about which account a real figure belongs to.
    const refs = verifyAccountReferences(
      texts,
      (snapshot.accounts as { name: string; last4: string | null }[]) ?? []
    );
    if (!refs.ok) {
      await db
        .from("agent_runs")
        .update({
          finished_at: new Date().toISOString(),
          tokens_used: tokensUsed,
          status: "failed",
          error: `misattributed accounts: ${refs.violations
            .slice(0, 5)
            .map((v) => `"${v.name}" cited as …${v.cited} (is ${v.valid.join("/")})`)
            .join("; ")}`,
        })
        .eq("id", run.id);
      await audit(db, "agent", "analysis_rejected_misattributed", "agent_runs", run.id, {
        violations: refs.violations.slice(0, 20),
      });
      console.error(`[agent] run rejected: ${refs.violations.length} misattributed account(s)`);
      return;
    }

    const grounding = verifyGrounding(texts, snapshot, proposedFigures);
    if (!grounding.ok) {
      await db
        .from("agent_runs")
        .update({
          finished_at: new Date().toISOString(),
          tokens_used: tokensUsed,
          status: "failed",
          error: `ungrounded figures: ${grounding.offenders
            .slice(0, 8)
            .map((o) => `${o.value} (${o.context})`)
            .join("; ")}`,
        })
        .eq("id", run.id);
      await audit(db, "agent", "analysis_rejected_ungrounded", "agent_runs", run.id, {
        offenders: grounding.offenders.slice(0, 20),
        checked: grounding.checked,
      });
      console.error(
        `[agent] run rejected: ${grounding.offenders.length} ungrounded figure(s) of ${grounding.checked}`
      );
      return;
    }
    for (const { rec, payload } of accepted) {
      await db.from("recommendations").insert({
        run_id: run.id,
        type: rec.type,
        summary: rec.summary,
        rationale: rec.rationale,
        // An alert is advisory and has nothing for the executor to act on; a
        // trade carries the shaped order, with the account filled in by code.
        payload,
        confidence: rec.confidence,
        status: "pending",
        expires_at: new Date(Date.now() + rec.expires_in_days * 86400_000).toISOString(),
      });
    }

    await db
      .from("agent_runs")
      .update({
        finished_at: new Date().toISOString(),
        tokens_used: tokensUsed,
        status: "done",
      })
      .eq("id", run.id);

    const trades = accepted.filter(({ payload }) => payload).length;
    await audit(db, "agent", "analysis_completed", "agent_runs", run.id, {
      recommendations: accepted.length,
      trades,
      discarded: discarded.length,
      tokens: tokensUsed,
      trigger,
    });
    console.log(
      `[agent] run complete: ${accepted.length} recommendations (${trades} trade), ${tokensUsed} tokens`
    );
  } catch (e: unknown) {
    const msg = (e as Error).message;
    console.error("[agent] run failed:", msg);
    await db
      .from("agent_runs")
      .update({ finished_at: new Date().toISOString(), status: "failed", error: msg })
      .eq("id", run.id);
    await audit(db, "agent", "analysis_failed", "agent_runs", run.id, { error: msg });
  }
}

export async function agentTick(db: SupabaseClient) {
  await runAgentAnalysis(db, "cron");
}

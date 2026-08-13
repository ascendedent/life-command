import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@finance/shared";
// The grounding gate lives with the recap because that is where it was first
// needed; it is not recap-specific and the agent is held to the same rule.
import { verifyGrounding, verifyAccountReferences } from "@finance/shared/src/recap";
import { attributionFrom, attributionMonthOf, isShiftableIncome } from "@finance/shared";

// Agent worker v1 (spec Phase 2, §8 prompt contract): assembles a derived
// financial snapshot, calls Claude, and writes ADVISORY recommendations only —
// payload is always null, and this worker can never call execution APIs.
// Account identifiers are masked to last-4 before anything reaches the model.

// Default model for analysis runs; per-function model selection from the UI
// is on the roadmap — until then, override via AGENT_MODEL in .env.
const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5";

const RecommendationSchema = z.object({
  type: z.enum(["alert"]),
  summary: z.string().describe("One plain-English sentence"),
  rationale: z
    .string()
    .describe("References the specific numbers from the snapshot driving this"),
  confidence: z.number().describe("0 to 1"),
  expires_in_days: z
    .number()
    .describe("How many days this recommendation stays relevant, 1-30"),
});

const AgentOutputSchema = z.object({
  recommendations: z
    .array(RecommendationSchema)
    .describe("Zero to five recommendations; only ones truly worth attention"),
});

const SYSTEM_PROMPT = `You are the analysis engine of a self-hosted personal finance platform serving exactly one user, its owner. You produce advisory recommendations only — nothing you output is executed; a human reads each one and acknowledges it.

Rules:
- Every number you write must appear verbatim in the snapshot. Do not add, subtract, average or round figures together — not even correctly. This is checked after the fact and a single unsourced figure discards the entire run, so if you want a total, use one from \`totals\`; if the total you want isn't there, describe the parts instead.
- Only surface recommendations that are genuinely worth the owner's attention: unusual spend, credit utilization risks, upcoming recurring charges that look wrong, cash-flow trends, idle cash, subscription anomalies. Zero recommendations is a valid answer.
- The owner has seen your last recommendations and their outcomes (provided). Do not repeat rejected or recently-made recommendations without new supporting data.
- Refer to an account only by its exact \`label\` from the snapshot. Never pair an account name with a last-four yourself: several accounts share a name and differ only by mask, so a name you assemble is a different account from the one you meant. This is checked, and a mismatch discards the run.
- Amounts follow the snapshot's convention: positive transaction amounts are outflows.
- Autonomy is level 0: analysis only. Never propose specific trades or transfers yet — frame findings as alerts.`;

interface SnapshotResult {
  snapshot: Record<string, unknown>;
  maskedAccounts: number;
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
        }
      : null,
    last_recommendations: lastRecs ?? [],
  };

  return { snapshot, maskedAccounts: accounts?.length ?? 0 };
}

export async function runAgentAnalysis(
  db: SupabaseClient,
  trigger: "cron" | "manual"
): Promise<void> {
  const { snapshot } = await buildSnapshot(db);

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
        format: zodOutputFormat(AgentOutputSchema),
      },
      system: SYSTEM_PROMPT,
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

    const recs = response.parsed_output.recommendations.filter(
      (r) => r.confidence >= 0 && r.confidence <= 1 && r.expires_in_days >= 1 && r.expires_in_days <= 30
    );

    // The system prompt asks the model to cite only snapshot figures. Asking is
    // not a guarantee, and the recap already proves the check is cheap — so the
    // agent is held to the same standard its narrative sibling is. A single
    // unsourced number fails the run: nothing is written, because an advisory
    // that quotes a balance you don't have is worse than no advisory.
    const texts = recs.flatMap((r) => [r.summary, r.rationale]);

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

    const grounding = verifyGrounding(texts, snapshot);
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
    for (const rec of recs) {
      await db.from("recommendations").insert({
        run_id: run.id,
        type: rec.type,
        summary: rec.summary,
        rationale: rec.rationale,
        payload: null, // advisory only in Phase 2 — executor has nothing to act on
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

    await audit(db, "agent", "analysis_completed", "agent_runs", run.id, {
      recommendations: recs.length,
      tokens: tokensUsed,
      trigger,
    });
    console.log(`[agent] run complete: ${recs.length} recommendations, ${tokensUsed} tokens`);
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

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  audit,
  checkGuardrails,
  alpacaConfigured,
  lastPrice,
  listPositions,
  placeOrder,
  AlpacaError,
  validateTradeProposal,
  type ExecutionMode,
  type GuardrailConfig,
  type GuardrailContext,
  type TradeRequest,
} from "@finance/shared";

/**
 * Executor (spec Phase 3a). The only worker that touches an execution API, and
 * it never calls the LLM: the recommendations table is the entire bridge
 * between what the model thought and what actually happens.
 *
 * It consumes *approved* rows, re-derives every guardrail input from the
 * database and the broker, and re-checks all of them. Approval is the owner
 * saying "I want this"; it says nothing about whether the trade is still inside
 * the limits they set when they were thinking about limits rather than about
 * this trade. Both have to be true, and the second is checked here, in code.
 *
 * Every attempt is recorded, refusals included. Thirty days with zero guardrail
 * violations is the acceptance criterion for this phase, and that is not
 * checkable against a table that only remembers the orders that went through.
 */

/**
 * The stored payload. Everything describing the order itself is validated by
 * `validateTradeProposal`; the only field the executor reads directly is the
 * account, because the agent never chooses it — code stamps in the one account
 * the owner flagged agent-controlled.
 */
interface TradePayload {
  account_id?: string;
}

async function record(
  db: SupabaseClient,
  row: {
    recommendation_id: string;
    mode: ExecutionMode;
    action: string;
    request: Record<string, unknown>;
    outcome: "rejected" | "submitted" | "filled" | "failed";
    violations?: string[];
    broker_order_id?: string | null;
    response?: unknown;
    error?: string | null;
  }
) {
  await db.from("executions").insert({
    recommendation_id: row.recommendation_id,
    broker: "alpaca",
    mode: row.mode,
    action: row.action,
    request: row.request,
    outcome: row.outcome,
    violations: row.violations ?? [],
    broker_order_id: row.broker_order_id ?? null,
    response: (row.response ?? null) as Record<string, unknown> | null,
    error: row.error ?? null,
  });
}

/** Dollars already executed today — the input to the daily cap. */
export async function spentToday(db: SupabaseClient): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data } = await db
    .from("executions")
    .select("request")
    .in("outcome", ["submitted", "filled"])
    .gte("created_at", since.toISOString());
  return (data ?? []).reduce(
    (s, r) => s + Number((r.request as { amount?: number } | null)?.amount ?? 0),
    0
  );
}

export async function executorTick(db: SupabaseClient): Promise<void> {
  const { data: approved } = await db
    .from("recommendations")
    .select("id, type, summary, payload, status, expires_at")
    .eq("status", "approved")
    .in("type", ["trade"])
    .limit(10);
  if (!approved?.length) return;

  const { data: cfgRow } = await db.from("agent_config").select("*").eq("id", 1).maybeSingle();
  if (!cfgRow) {
    console.error("[executor] no agent_config row — refusing to execute anything");
    return;
  }
  const mode: ExecutionMode = cfgRow.execution_mode === "live" ? "live" : "paper";
  const cfg: GuardrailConfig = {
    autonomy_level: cfgRow.autonomy_level,
    max_txn_amount: Number(cfgRow.max_txn_amount),
    max_daily_amount: Number(cfgRow.max_daily_amount),
    max_open_positions: cfgRow.max_open_positions,
    max_position_size: Number(cfgRow.max_position_size),
    allowed_action_types: cfgRow.allowed_action_types ?? [],
  };

  for (const rec of approved) {
    const payload = (rec.payload ?? {}) as TradePayload;

    // Whoever wrote the payload, it is validated here before anything acts on
    // it. The agent checks the same rules when it proposes, but a row in a
    // table is not proof of what wrote it, and a malformed order must fail
    // against our own rules rather than against the broker's.
    const shaped = validateTradeProposal(rec.payload);
    if (!shaped.ok) {
      await record(db, {
        recommendation_id: rec.id,
        mode, action: "trade",
        request: { payload: rec.payload, account_id: payload.account_id ?? null },
        outcome: "rejected",
        violations: shaped.problems,
      });
      await db
        .from("recommendations")
        .update({ status: "failed", result: { rejected_by: "payload", problems: shaped.problems } })
        .eq("id", rec.id);
      await audit(db, "system", "execution_rejected", "recommendations", rec.id, {
        problems: shaped.problems,
      });
      console.error(`[executor] ${rec.id} malformed payload: ${shaped.problems.join("; ")}`);
      continue;
    }
    const { symbol, side } = shaped.proposal;

    // Price the order before judging it. A qty-denominated order has no dollar
    // value until the market says so, and a cap in dollars cannot be enforced
    // against a number of shares.
    let amount = shaped.proposal.notional ?? Number.NaN;
    let price: number | null = null;
    if (shaped.proposal.qty) {
      price = alpacaConfigured() ? await lastPrice(mode, symbol) : null;
      amount = price ? shaped.proposal.qty * price : Number.NaN;
    }

    // Broker truth for positions, not our own stale holdings table.
    let positions: { symbol: string; qty: string; market_value: string }[] = [];
    let brokerReadable = false;
    if (alpacaConfigured()) {
      try {
        positions = await listPositions(mode);
        brokerReadable = true;
      } catch (e) {
        console.error(`[executor] could not read positions: ${(e as Error).message}`);
      }
    }
    const held = positions.find((p) => p.symbol === symbol);

    const request = {
      symbol,
      side,
      amount,
      qty: shaped.proposal.qty,
      notional: shaped.proposal.notional,
      limit_price: shaped.proposal.limit_price,
      price_used: price,
      account_id: payload.account_id ?? null,
      recommendation: rec.summary,
    };

    // Never guess at the state the limits are measured against. If the broker
    // could not be read, position counts and sizes are unknown, and an unknown
    // is not a zero.
    if (!alpacaConfigured() || !brokerReadable) {
      const reason = !alpacaConfigured()
        ? "Alpaca is not configured (ALPACA_KEY_ID / ALPACA_SECRET_KEY)"
        : "broker positions could not be read, so guardrail inputs are unknown";

      // This is an infrastructure problem, not a verdict on the trade, so the
      // recommendation stays approved and will run once the broker is
      // reachable. But the executor ticks every minute, and recording the same
      // complaint every minute would bury the real refusals in an append-only
      // table. Say it once per recommendation, then wait quietly.
      const { count: alreadyLogged } = await db
        .from("executions")
        .select("id", { count: "exact", head: true })
        .eq("recommendation_id", rec.id)
        .eq("outcome", "rejected")
        .contains("violations", [reason]);
      if (!alreadyLogged) {
        await record(db, {
          recommendation_id: rec.id,
          mode, action: "trade", request, outcome: "rejected",
          violations: [reason],
        });
        await audit(db, "system", "execution_blocked", "recommendations", rec.id, { reason });
        console.error(`[executor] ${rec.id}: ${reason}`);
      }
      continue;
    }

    let accountAgentControlled = false;
    if (payload.account_id) {
      const { data: acct } = await db
        .from("accounts")
        .select("is_agent_controlled")
        .eq("id", payload.account_id)
        .maybeSingle();
      accountAgentControlled = !!acct?.is_agent_controlled;
    }

    const req: TradeRequest = {
      type: rec.type, symbol, side, amount, account_id: payload.account_id ?? null,
    };
    const ctx: GuardrailContext = {
      now: new Date(),
      status: rec.status,
      expires_at: rec.expires_at,
      spent_today: await spentToday(db),
      open_positions: positions.length,
      already_held: !!held,
      position_value: held ? Number(held.market_value) : 0,
      position_qty: held ? Number(held.qty) : 0,
      account_is_agent_controlled: accountAgentControlled,
    };

    const verdict = checkGuardrails(req, cfg, ctx);
    if (!verdict.ok) {
      await record(db, {
        recommendation_id: rec.id,
        mode, action: "trade", request, outcome: "rejected",
        violations: verdict.violations,
      });
      await db
        .from("recommendations")
        .update({ status: "failed", result: { rejected_by: "guardrails", violations: verdict.violations } })
        .eq("id", rec.id);
      await audit(db, "system", "execution_rejected", "recommendations", rec.id, {
        violations: verdict.violations,
      });
      console.error(`[executor] ${symbol} refused: ${verdict.violations.join("; ")}`);
      continue;
    }

    try {
      const order = await placeOrder(mode, {
        symbol,
        side,
        type: shaped.proposal.limit_price ? "limit" : "market",
        time_in_force: shaped.proposal.time_in_force,
        ...(shaped.proposal.limit_price ? { limit_price: shaped.proposal.limit_price } : {}),
        ...(shaped.proposal.notional
          ? { notional: shaped.proposal.notional }
          : { qty: shaped.proposal.qty ?? undefined }),
        // Idempotency: a retry after a timeout must not open a second position.
        client_order_id: `rec-${rec.id}`,
      });
      await record(db, {
        recommendation_id: rec.id,
        mode, action: "trade", request, outcome: "submitted",
        broker_order_id: String(order.id ?? ""),
        response: order,
      });
      await db
        .from("recommendations")
        .update({ status: "executed", executed_at: new Date().toISOString(), result: order })
        .eq("id", rec.id);
      await audit(db, "system", "execution_submitted", "recommendations", rec.id, {
        symbol, side, amount, mode, broker_order_id: order.id,
      });
      console.log(`[executor] ${mode} ${side} ${symbol} $${amount.toFixed(2)} → order ${order.id}`);
    } catch (e: unknown) {
      const err = e as AlpacaError;
      await record(db, {
        recommendation_id: rec.id,
        mode, action: "trade", request, outcome: "failed",
        response: err instanceof AlpacaError ? err.body : null,
        error: err.message,
      });
      await db
        .from("recommendations")
        .update({ status: "failed", result: { error: err.message } })
        .eq("id", rec.id);
      await audit(db, "system", "execution_failed", "recommendations", rec.id, { error: err.message });
      console.error(`[executor] ${symbol} failed: ${err.message}`);
    }
  }
}

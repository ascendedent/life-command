// Execution guardrails (spec §7 and Phase 3).
//
// These run in code, at execution time, against the database — never in a
// prompt. The model proposes; this decides. A recommendation that was approved
// by the owner is still checked here, because approval says "I want this" and
// says nothing about whether it is within the limits the owner set earlier,
// when they were thinking about limits rather than about this trade.
//
// Pure on purpose: the executor reads the world, this judges it, and the
// judgement can be tested exhaustively without a broker or a database.

export interface GuardrailConfig {
  autonomy_level: number;
  max_txn_amount: number;
  max_daily_amount: number;
  max_open_positions: number;
  max_position_size: number;
  allowed_action_types: string[];
}

export interface TradeRequest {
  /** Recommendation type, checked against allowed_action_types. */
  type: string;
  symbol: string;
  side: "buy" | "sell";
  /** Dollar value of this order as the executor priced it. */
  amount: number;
  account_id: string | null;
}

export interface GuardrailContext {
  now: Date;
  /** Recommendation status at the moment of execution. */
  status: string;
  expires_at: string | null;
  /** Dollars already executed today, across every recommendation. */
  spent_today: number;
  /** Distinct symbols currently held in the agent-controlled account. */
  open_positions: number;
  /** True when this symbol is already held, so buying adds rather than opens. */
  already_held: boolean;
  /** Current market value of the position in this symbol. */
  position_value: number;
  /** Quantity held, for validating a sell. */
  position_qty: number;
  /** Whether the target account is flagged agent-eligible. */
  account_is_agent_controlled: boolean;
}

export interface GuardrailVerdict {
  ok: boolean;
  /** Every rule that refused, not just the first — the owner should see all of them. */
  violations: string[];
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Decide whether an approved recommendation may execute.
 *
 * Every rule is checked, and every failure is reported. Stopping at the first
 * one would let the owner fix a cap, retry, and hit the next wall without ever
 * seeing the shape of the problem.
 */
export function checkGuardrails(
  req: TradeRequest,
  cfg: GuardrailConfig,
  ctx: GuardrailContext
): GuardrailVerdict {
  const v: string[] = [];

  // Only an explicitly approved recommendation is executable. Phase 3 is
  // approval-gated by definition; auto-execution arrives in Phase 4 behind
  // autonomy level 3, and until then a pending row must never fire.
  if (ctx.status !== "approved") {
    v.push(`status is "${ctx.status}", not approved`);
  }

  // The autonomy dial is the owner's master switch — 0 read-only, 1 recommend,
  // 2 approve-to-execute, 3 bounded auto — and nothing was reading it. Every
  // other limit was enforced, so the hole was invisible: turning the dial down
  // to 0 looked like it disarmed the executor and did not. Approval alone is
  // not consent to execute; the owner has to have said execution is on at all.
  if (cfg.autonomy_level < 2) {
    v.push(
      `autonomy level ${cfg.autonomy_level} does not permit execution (2 = approve-to-execute)`
    );
  }

  // An expired recommendation describes a market that no longer exists.
  if (ctx.expires_at && Date.parse(ctx.expires_at) < ctx.now.getTime()) {
    v.push(`recommendation expired at ${ctx.expires_at}`);
  }

  if (!cfg.allowed_action_types.includes(req.type)) {
    v.push(
      `action type "${req.type}" is not allow-listed (allowed: ${
        cfg.allowed_action_types.length ? cfg.allowed_action_types.join(", ") : "none"
      })`
    );
  }

  // A malformed amount must never be treated as "small".
  if (!Number.isFinite(req.amount) || req.amount <= 0) {
    v.push(`order amount ${req.amount} is not a positive number`);
  } else {
    if (req.amount > cfg.max_txn_amount) {
      v.push(
        `order ${money(req.amount)} exceeds the per-transaction cap ${money(cfg.max_txn_amount)}`
      );
    }
    if (ctx.spent_today + req.amount > cfg.max_daily_amount) {
      v.push(
        `order ${money(req.amount)} would take today's total to ${money(
          ctx.spent_today + req.amount
        )}, over the daily cap ${money(cfg.max_daily_amount)}`
      );
    }
  }

  if (!req.account_id) {
    v.push("no account specified for the order");
  } else if (!ctx.account_is_agent_controlled) {
    v.push("target account is not flagged agent-controlled");
  }

  if (req.side === "buy") {
    // Only an order that opens a *new* position can breach the position count.
    if (!ctx.already_held && ctx.open_positions >= cfg.max_open_positions) {
      v.push(
        `already holding ${ctx.open_positions} positions, at the limit of ${cfg.max_open_positions}`
      );
    }
    if (ctx.position_value + req.amount > cfg.max_position_size) {
      v.push(
        `position in ${req.symbol} would reach ${money(
          ctx.position_value + req.amount
        )}, over the per-position cap ${money(cfg.max_position_size)}`
      );
    }
  }

  if (req.side === "sell" && ctx.position_qty <= 0) {
    v.push(`no position in ${req.symbol} to sell`);
  }

  if (!req.symbol || !/^[A-Z.]{1,10}$/.test(req.symbol)) {
    v.push(`symbol "${req.symbol}" is not a plausible ticker`);
  }

  return { ok: v.length === 0, violations: v };
}


// -----------------------------------------------------------------------------
// Trade proposals
// -----------------------------------------------------------------------------

/**
 * A trade the agent proposed, after shaping. The dollar/share distinction
 * matters all the way down: a cap in dollars cannot be enforced against a
 * number of shares until something prices it.
 */
export interface TradeProposal {
  symbol: string;
  side: "buy" | "sell";
  /** Dollar-denominated order. Mutually exclusive with `qty`. */
  notional: number | null;
  /** Share-denominated order. Mutually exclusive with `notional`. */
  qty: number | null;
  limit_price: number | null;
  time_in_force: "day" | "gtc";
}

export type TradeProposalResult =
  | { ok: true; proposal: TradeProposal }
  | { ok: false; problems: string[] };

const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Shape and validate a proposed order before anything acts on it.
 *
 * Shared by the agent (which refuses to write a proposal that cannot execute)
 * and the executor (which refuses to submit one, whoever wrote it). The
 * combinations rejected here are the ones the broker rejects too — a notional
 * order carrying a limit price, a GTC order with no share count — and finding
 * that out from a 422 after an approval is a worse way to learn it.
 */
export function validateTradeProposal(raw: unknown): TradeProposalResult {
  const p = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];

  const symbol = String(p.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z.]{1,10}$/.test(symbol)) {
    problems.push(`symbol "${p.symbol ?? ""}" is not a plausible ticker`);
  }

  const side = p.side === "buy" || p.side === "sell" ? p.side : null;
  if (!side) problems.push(`side "${p.side ?? ""}" is neither buy nor sell`);

  const notional = positive(p.notional) ? p.notional : null;
  const qty = positive(p.qty) ? p.qty : null;
  if (notional && qty) {
    problems.push("order gives both a dollar amount and a share count — pick one");
  } else if (!notional && !qty) {
    problems.push("order gives neither a positive dollar amount nor a positive share count");
  }

  const limit = p.limit_price == null ? null : positive(p.limit_price) ? p.limit_price : Number.NaN;
  if (Number.isNaN(limit)) {
    problems.push(`limit price ${String(p.limit_price)} is not a positive number`);
  } else if (limit && notional) {
    // Alpaca prices a notional order at the market; a limit needs a share count.
    problems.push("a limit price requires a share count, not a dollar amount");
  }

  // A notional order is market-and-day at the broker, so anything else asked
  // for is silently not what would happen. Say so rather than quietly coerce.
  const tif = p.time_in_force === "gtc" ? "gtc" : "day";
  if (tif === "gtc" && notional) {
    problems.push("a dollar-denominated order is good for the day only, not GTC");
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    proposal: {
      symbol,
      side: side as "buy" | "sell",
      notional,
      qty,
      limit_price: (limit as number) || null,
      time_in_force: tif,
    },
  };
}

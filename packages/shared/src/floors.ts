// Floors — guardrails about the state an action leaves behind (spec Phase 3.5).
//
// `checkGuardrails` asks whether an action is too big. This asks whether the
// balance sheet after it is one the owner agreed to live with. The two cannot
// be the same check: "never below $10,000 liquid" is satisfied by every
// individual $4,000 transfer and violated by two of them.
//
// Pure, so it can be tested exhaustively; the database work is `loadFloorState`
// at the bottom, which does no deciding.

import type { SupabaseClient } from "@supabase/supabase-js";

export type FloorKind =
  | "liquid_minimum"
  | "account_minimum"
  | "credit_utilization_max"
  | "never_touch";

export interface Floor {
  id: string;
  kind: FloorKind;
  account_id: string | null;
  amount: number | null;
  pct: number | null;
  months: number | null;
  horizon_days: number;
  enabled: boolean;
  note: string | null;
}

export interface FloorAccount {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  balance: number;
  /** Plaid's available balance. On a card this is the remaining credit. */
  available: number | null;
  /** When this account's balance was last refreshed. */
  updated_at: string | null;
}

export interface FloorState {
  asOf: Date;
  accounts: FloorAccount[];
  /** Obligations falling due inside a floor's horizon. */
  committed: { account_id: string | null; amount: number; due: string }[];
  /** Trailing average monthly expense, for a floor stated in months. */
  monthlyExpenses: number;
  /**
   * How many recurring items exist versus how many carry a due date. A
   * committed-cash reservation computed from zero dated obligations is not a
   * reservation, and the difference has to be visible rather than inferred
   * from a suspiciously round $0.
   */
  obligationCoverage: { dated: number; total: number };
}

/** A proposed movement. Negative leaves the account, positive arrives. */
export interface FloorDelta {
  account_id: string | null;
  amount: number;
}

export interface FloorReading {
  id: string;
  kind: FloorKind;
  label: string;
  /** The line itself, in the unit the floor is stated in. */
  limit: number;
  /** Where the projection puts us, same unit. */
  projected: number;
  /** Positive is room to spare. Negative is a breach. */
  headroom: number;
  ok: boolean;
  /** False when the inputs do not support a verdict — treated as a refusal. */
  evaluable: boolean;
  detail: string;
}

export interface FloorVerdict {
  ok: boolean;
  violations: string[];
  readings: FloorReading[];
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Balances older than this are a guess, and the honest response to a guess is
 * to refuse rather than to assume. Only the accounts a given floor actually
 * measures are checked, so one dead institution cannot freeze every floor.
 */
const MAX_STALENESS_HOURS = 24;

/** Recurring statuses that still represent money owed. */
const OWED_STATUSES = ["active", "price_changed", "missed"];

const hoursOld = (iso: string | null, now: Date): number =>
  iso == null ? Number.POSITIVE_INFINITY : (now.getTime() - Date.parse(iso)) / 3_600_000;

/**
 * Evaluate every floor against the state the delta would produce.
 *
 * Conservative on every axis: outflows count immediately, obligations inside
 * the horizon are already spent, and an input that cannot be read is a refusal
 * rather than a pass.
 */
export function evaluateFloors(
  floors: Floor[],
  state: FloorState,
  delta: FloorDelta | null
): FloorVerdict {
  const active = floors.filter((f) => f.enabled);
  const readings: FloorReading[] = [];
  const violations: string[] = [];
  const byId = new Map(state.accounts.map((a) => [a.id, a]));

  const neverTouch = new Set(
    active.filter((f) => f.kind === "never_touch").map((f) => f.account_id!)
  );

  const applied = (a: FloorAccount): number =>
    a.balance + (delta && delta.account_id === a.id ? delta.amount : 0);

  const committedFor = (accountIds: Set<string> | null, horizon: number): number => {
    const cutoff = new Date(state.asOf.getTime() + horizon * 86400_000);
    return state.committed
      // Past due dates are included deliberately: an obligation that came due
      // last week and has not been seen is more certainly owed than one due
      // next week, not less.
      .filter((c) => Date.parse(c.due) <= cutoff.getTime())
      // An obligation with no account named still has to come from somewhere,
      // so it counts against the household total but not against one account.
      .filter((c) => (accountIds ? c.account_id != null && accountIds.has(c.account_id) : true))
      .reduce((s, c) => s + Math.abs(c.amount), 0);
  };

  for (const f of active) {
    if (f.kind === "never_touch") {
      const acct = byId.get(f.account_id!);
      const label = `Never touch ${acct?.name ?? "account"} ‥${acct?.mask ?? "????"}`;
      const touched = !!delta && delta.account_id === f.account_id;
      if (touched) violations.push(`${label}: the proposed action draws on it`);
      readings.push({
        id: f.id, kind: f.kind, label, limit: 0, projected: 0, headroom: 0,
        ok: !touched, evaluable: true,
        detail: touched ? "the proposed action draws on it" : "untouched",
      });
      continue;
    }

    if (f.kind === "liquid_minimum") {
      // Never-touch accounts are not liquidity the agent has; counting them
      // would let a floor be satisfied by money the agent may not reach.
      const pool = state.accounts.filter(
        (a) => a.type === "depository" && !neverTouch.has(a.id)
      );
      const stale = pool.filter((a) => hoursOld(a.updated_at, state.asOf) > MAX_STALENESS_HOURS);
      const limit =
        f.amount != null ? f.amount : (f.months ?? 0) * state.monthlyExpenses;
      const raw = pool.reduce((s, a) => s + applied(a), 0);
      const committed = committedFor(new Set(pool.map((a) => a.id)), f.horizon_days);
      const projected = raw - committed;
      const label = f.amount != null
        ? `Liquid minimum ${money(limit)}`
        : `Liquid minimum ${f.months} months of expenses (${money(limit)})`;

      if (stale.length) {
        const detail = `${stale.length} of ${pool.length} cash accounts have not refreshed in ${MAX_STALENESS_HOURS}h — the balance is a guess`;
        violations.push(`${label}: ${detail}`);
        readings.push({ id: f.id, kind: f.kind, label, limit, projected, headroom: projected - limit, ok: false, evaluable: false, detail });
        continue;
      }
      if (f.amount == null && !state.monthlyExpenses) {
        const detail = "no expense history to measure months against";
        violations.push(`${label}: ${detail}`);
        readings.push({ id: f.id, kind: f.kind, label, limit, projected, headroom: projected - limit, ok: false, evaluable: false, detail });
        continue;
      }

      const ok = projected >= limit;
      if (!ok) {
        violations.push(
          `${label}: this would leave ${money(projected)}, ${money(limit - projected)} below it`
        );
      }
      readings.push({
        id: f.id, kind: f.kind, label, limit, projected, headroom: projected - limit, ok, evaluable: true,
        detail: committed
          ? `${money(raw)} on hand less ${money(committed)} committed in the next ${f.horizon_days} days`
          : `${money(raw)} on hand, nothing dated as committed in the next ${f.horizon_days} days`,
      });
      continue;
    }

    if (f.kind === "account_minimum") {
      const acct = byId.get(f.account_id!);
      const label = `${acct?.name ?? "Account"} ‥${acct?.mask ?? "????"} minimum ${money(f.amount ?? 0)}`;
      if (!acct) {
        const detail = "the account this floor names no longer exists";
        violations.push(`${label}: ${detail}`);
        readings.push({ id: f.id, kind: f.kind, label, limit: f.amount ?? 0, projected: 0, headroom: 0, ok: false, evaluable: false, detail });
        continue;
      }
      if (hoursOld(acct.updated_at, state.asOf) > MAX_STALENESS_HOURS) {
        const detail = `balance has not refreshed in ${MAX_STALENESS_HOURS}h`;
        violations.push(`${label}: ${detail}`);
        readings.push({ id: f.id, kind: f.kind, label, limit: f.amount ?? 0, projected: 0, headroom: 0, ok: false, evaluable: false, detail });
        continue;
      }
      const committed = committedFor(new Set([acct.id]), f.horizon_days);
      const projected = applied(acct) - committed;
      const limit = f.amount ?? 0;
      const ok = projected >= limit;
      if (!ok) {
        violations.push(`${label}: this would leave ${money(projected)}, ${money(limit - projected)} below it`);
      }
      readings.push({
        id: f.id, kind: f.kind, label, limit, projected, headroom: projected - limit, ok, evaluable: true,
        detail: committed ? `less ${money(committed)} due within ${f.horizon_days} days` : "no dated obligations on this account",
      });
      continue;
    }

    // credit_utilization_max
    const cards = state.accounts.filter((a) => a.type === "credit");
    // Plaid gives remaining credit, not the limit, so the limit is the sum of
    // the two — and a card that reports no available balance has no knowable
    // limit. One unknown card makes the ratio unknowable, and an unknowable
    // ratio is not a passing one.
    const unknown = cards.filter((a) => a.available == null);
    const label = `Credit utilization ceiling ${(f.pct ?? 0).toFixed(0)}%`;
    if (!cards.length) {
      readings.push({ id: f.id, kind: f.kind, label, limit: f.pct ?? 0, projected: 0, headroom: f.pct ?? 0, ok: true, evaluable: true, detail: "no credit accounts" });
      continue;
    }
    if (unknown.length) {
      const detail = `${unknown.length} of ${cards.length} cards report no credit limit, so utilization cannot be computed`;
      violations.push(`${label}: ${detail}`);
      readings.push({ id: f.id, kind: f.kind, label, limit: f.pct ?? 0, projected: 0, headroom: 0, ok: false, evaluable: false, detail });
      continue;
    }
    const balances = cards.reduce((s, a) => s + applied(a), 0);
    const limits = cards.reduce((s, a) => s + a.balance + (a.available ?? 0), 0);
    const projected = limits ? (balances / limits) * 100 : 0;
    const limit = f.pct ?? 0;
    const ok = projected <= limit;
    if (!ok) {
      violations.push(`${label}: this would put utilization at ${projected.toFixed(1)}%`);
    }
    readings.push({
      id: f.id, kind: f.kind, label, limit, projected, headroom: limit - projected, ok, evaluable: true,
      detail: `${money(balances)} drawn against ${money(limits)} of limit`,
    });
  }

  return { ok: violations.length === 0, violations, readings };
}

/**
 * Read the world the floors are measured against. Decides nothing.
 */
export async function loadFloorState(
  db: SupabaseClient,
  now = new Date()
): Promise<FloorState> {
  const horizonEnd = new Date(now.getTime() + 90 * 86400_000).toISOString().slice(0, 10);
  const [{ data: accounts }, { data: recurring }, { data: allRecurring }, { data: spend }] =
    await Promise.all([
      db.from("accounts").select("id, name, mask, type, current_balance, available_balance, updated_at"),
      // Everything except cancelled. A bill this platform flagged as `missed`
      // is overdue, not forgiven — reserving only `active` obligations would
      // treat the one bill most certainly owed as not owed at all. Spelled out
      // rather than `neq`, which would also have to reason about NULL.
      db
        .from("recurring_items")
        .select("account_id, expected_amount, next_expected_date")
        .in("status", OWED_STATUSES)
        .not("next_expected_date", "is", null)
        .lte("next_expected_date", horizonEnd),
      db.from("recurring_items").select("id, next_expected_date").in("status", OWED_STATUSES),
      db
        .from("transactions")
        .select("amount, categories (category_groups (type))")
        .gte("date", new Date(now.getTime() - 180 * 86400_000).toISOString().slice(0, 10))
        .eq("hidden", false)
        .gt("amount", 0)
        .limit(5000),
    ]);

  // Six months of spending, transfers excluded — the same dollar moving between
  // the owner's own accounts is not an expense a cash floor should reserve for.
  const expenses = (spend ?? []).filter(
    (t) =>
      (t.categories as unknown as { category_groups?: { type: string } | null } | null)
        ?.category_groups?.type !== "transfer"
  );
  const monthlyExpenses =
    Math.round((expenses.reduce((s, t) => s + Number(t.amount), 0) / 6) * 100) / 100;

  return {
    asOf: now,
    accounts: (accounts ?? []).map((a) => ({
      id: a.id as string,
      name: a.name as string,
      mask: a.mask as string | null,
      type: a.type as string,
      balance: Number(a.current_balance ?? 0),
      available: a.available_balance == null ? null : Number(a.available_balance),
      updated_at: a.updated_at as string | null,
    })),
    committed: (recurring ?? []).map((r) => ({
      account_id: (r.account_id as string | null) ?? null,
      amount: Number(r.expected_amount ?? 0),
      due: r.next_expected_date as string,
    })),
    monthlyExpenses,
    obligationCoverage: {
      dated: (allRecurring ?? []).filter((r) => r.next_expected_date).length,
      total: (allRecurring ?? []).length,
    },
  };
}

/**
 * Goal linkage, contribution matching and pace math (spec §5.3).
 *
 * Pure and browser-safe, like reports.ts: the wizard's historical preview, the
 * nightly matcher, and the recap engine all run these same functions, so what
 * the preview promises is exactly what the worker later records.
 */

import type { ReportTxn } from "./reports";
import { round2 } from "./reports";

export type LinkRole = "funding" | "contribution_source" | "cost_driver" | "constraint";
export type LinkEntity = "account" | "category" | "tag" | "liability" | "recurring_item";
export type GoalType =
  | "emergency_fund"
  | "debt_payoff"
  | "savings_target"
  | "investment_target"
  | "custom";

export interface GoalLink {
  id?: string;
  goal_id?: string;
  entity_type: LinkEntity;
  entity_id: string;
  role: LinkRole;
  notes?: string | null;
}

export interface GoalRow {
  id: string;
  name: string;
  type: GoalType;
  target_amount: number | null;
  current_amount: number;
  target_date: string | null;
  cadence_amount: number | null;
  cadence: string | null;
  priority: number;
  funding_account_id: string | null;
  status: string;
  created_at?: string;
}

export interface ContributionMatch {
  transaction_id: string;
  date: string;
  amount: number; // positive = moved toward the goal
  merchant: string;
  /** Which link caught it, for the "why did this count?" column. */
  via: string;
  entity_type: LinkEntity;
  entity_id: string;
}

export interface MatchContext {
  /** transaction id → set of tag ids */
  tagsByTxn?: Map<string, Set<string>>;
  /** category id → category name, for readable `via` labels */
  categoryNames?: Map<string, string>;
  accountNames?: Map<string, string>;
  tagNames?: Map<string, string>;
}

/**
 * Which transactions count as contributions to a goal.
 *
 * Direction depends on the link:
 *   - a *funding account* holds the goal's money, so money arriving there
 *     (an inflow) is the contribution;
 *   - a *contribution category/tag* describes the act of paying in, so the
 *     outflow from the paying account is the contribution.
 * Both sides of the same transfer often exist as two Plaid transactions — see
 * dedupeMatches.
 */
export function matchContributions(
  txns: ReportTxn[],
  links: GoalLink[],
  ctx: MatchContext = {}
): ContributionMatch[] {
  const funding = links.filter((l) => l.role === "funding" && l.entity_type === "account");
  const sources = links.filter((l) => l.role === "contribution_source");
  const out: ContributionMatch[] = [];

  for (const txn of txns) {
    const amount = Number(txn.amount);
    const name = txn.merchant_clean || txn.merchant || "—";

    for (const link of funding) {
      if (txn.account_id !== link.entity_id || amount >= 0) continue;
      out.push({
        transaction_id: txn.id,
        date: txn.date,
        amount: round2(-amount),
        merchant: name,
        via: `into ${ctx.accountNames?.get(link.entity_id) ?? "funding account"}`,
        entity_type: "account",
        entity_id: link.entity_id,
      });
    }

    for (const link of sources) {
      if (amount <= 0) continue;
      if (link.entity_type === "category" && txn.category_id === link.entity_id) {
        out.push({
          transaction_id: txn.id,
          date: txn.date,
          amount: round2(amount),
          merchant: name,
          via: `category ${ctx.categoryNames?.get(link.entity_id) ?? "linked"}`,
          entity_type: "category",
          entity_id: link.entity_id,
        });
      } else if (link.entity_type === "tag" && ctx.tagsByTxn?.get(txn.id)?.has(link.entity_id)) {
        out.push({
          transaction_id: txn.id,
          date: txn.date,
          amount: round2(amount),
          merchant: name,
          via: `tag ${ctx.tagNames?.get(link.entity_id) ?? "linked"}`,
          entity_type: "tag",
          entity_id: link.entity_id,
        });
      } else if (link.entity_type === "account" && txn.account_id === link.entity_id) {
        out.push({
          transaction_id: txn.id,
          date: txn.date,
          amount: round2(amount),
          merchant: name,
          via: `from ${ctx.accountNames?.get(link.entity_id) ?? "linked account"}`,
          entity_type: "account",
          entity_id: link.entity_id,
        });
      }
    }
  }

  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * One dollar moved once should count once. A transfer normally lands twice
 * (outflow from checking, inflow to savings) and a transaction can satisfy two
 * links at the same time; both collapse here.
 */
export function dedupeMatches(matches: ContributionMatch[], windowDays = 3): ContributionMatch[] {
  const kept: ContributionMatch[] = [];
  const seenTxn = new Set<string>();

  for (const m of [...matches].sort((a, b) => a.date.localeCompare(b.date))) {
    if (seenTxn.has(m.transaction_id)) continue;
    const twin = kept.find(
      (k) =>
        Math.abs(k.amount - m.amount) < 0.005 &&
        Math.abs(Date.parse(k.date) - Date.parse(m.date)) <= windowDays * 86400_000
    );
    if (twin) continue;
    seenTxn.add(m.transaction_id);
    kept.push(m);
  }

  return kept.sort((a, b) => b.date.localeCompare(a.date));
}

export interface PaceResult {
  contributed: number;
  current: number;
  target: number | null;
  remaining: number | null;
  monthsRemaining: number | null;
  requiredPerMonth: number | null;
  observedPerMonth: number | null;
  expectedByNow: number | null;
  status: "ahead" | "on_pace" | "behind" | "no_target";
  projectedDate: string | null;
  /** Cadence goals ("save $800/month"): this period's expectation vs reality. */
  cadenceExpected: number | null;
  cadenceActual: number | null;
}

const MONTH_MS = 30.4375 * 86400_000;

/**
 * Where the goal stands. Deliberately linear: a straight line between start and
 * target date is the assumption the user made when they set the date, and it is
 * the one they can check by hand.
 */
export function pace(
  goal: GoalRow,
  matches: ContributionMatch[],
  today = new Date()
): PaceResult {
  const contributed = round2(matches.reduce((s, m) => s + m.amount, 0));
  const current = Number(goal.current_amount ?? 0);
  const target = goal.target_amount != null ? Number(goal.target_amount) : null;
  const now = today.getTime();

  // Observed rate: trailing 3 months of matched contributions.
  const cutoff = now - 3 * MONTH_MS;
  const recent = matches.filter((m) => Date.parse(m.date) >= cutoff);
  const observedPerMonth = recent.length ? round2(recent.reduce((s, m) => s + m.amount, 0) / 3) : 0;

  const start = goal.created_at ? Date.parse(goal.created_at) : now;
  const end = goal.target_date ? Date.parse(`${goal.target_date}T00:00:00Z`) : null;

  let expectedByNow: number | null = null;
  let monthsRemaining: number | null = null;
  let requiredPerMonth: number | null = null;
  let status: PaceResult["status"] = "no_target";
  let projectedDate: string | null = null;

  if (target != null && end) {
    const span = Math.max(end - start, 1);
    const elapsed = Math.min(Math.max(now - start, 0), span);
    expectedByNow = round2(target * (elapsed / span));
    monthsRemaining = Math.max((end - now) / MONTH_MS, 0);
    const remaining = Math.max(target - current, 0);
    requiredPerMonth = monthsRemaining > 0 ? round2(remaining / monthsRemaining) : remaining;
    const tolerance = Math.max(target * 0.02, 1);
    status =
      current >= expectedByNow + tolerance
        ? "ahead"
        : current <= expectedByNow - tolerance
          ? "behind"
          : "on_pace";
    if (observedPerMonth > 0 && remaining > 0) {
      projectedDate = new Date(now + (remaining / observedPerMonth) * MONTH_MS)
        .toISOString()
        .slice(0, 10);
    } else if (remaining <= 0) {
      projectedDate = new Date(now).toISOString().slice(0, 10);
    }
  } else if (target != null) {
    const remaining = Math.max(target - current, 0);
    status = "no_target";
    if (observedPerMonth > 0 && remaining > 0) {
      projectedDate = new Date(now + (remaining / observedPerMonth) * MONTH_MS)
        .toISOString()
        .slice(0, 10);
    }
  }

  // Cadence goals are judged on the current calendar period, not cumulatively.
  let cadenceExpected: number | null = null;
  let cadenceActual: number | null = null;
  if (goal.cadence_amount != null && goal.cadence) {
    cadenceExpected = Number(goal.cadence_amount);
    const periodStart =
      goal.cadence === "weekly"
        ? new Date(now - ((today.getUTCDay() + 6) % 7) * 86400_000)
        : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const key = periodStart.toISOString().slice(0, 10);
    cadenceActual = round2(
      matches.filter((m) => m.date >= key).reduce((s, m) => s + m.amount, 0)
    );
    if (status === "no_target") {
      const tol = Math.max(cadenceExpected * 0.02, 1);
      status =
        cadenceActual >= cadenceExpected + tol
          ? "ahead"
          : cadenceActual <= cadenceExpected - tol
            ? "behind"
            : "on_pace";
    }
  }

  return {
    contributed,
    current: round2(current),
    target,
    remaining: target != null ? round2(Math.max(target - current, 0)) : null,
    monthsRemaining: monthsRemaining != null ? Math.round(monthsRemaining * 10) / 10 : null,
    requiredPerMonth,
    observedPerMonth,
    expectedByNow,
    status,
    projectedDate,
    cadenceExpected,
    cadenceActual,
  };
}

export interface NetEfficiency {
  contributed: number;
  cost: number;
  net: number;
  /** cost per dollar kept — 0.05 means a nickel of cost for every dollar saved */
  costRatio: number | null;
}

export function netEfficiency(contributed: number, costs: number[]): NetEfficiency {
  const cost = round2(costs.reduce((s, c) => s + c, 0));
  return {
    contributed: round2(contributed),
    cost,
    net: round2(contributed - cost),
    costRatio: contributed > 0 ? Math.round((cost / contributed) * 1000) / 1000 : null,
  };
}

export interface InterestProjection {
  balance: number;
  apr_percent: number;
  days: number;
  daily_rate: number;
  interest: number;
  formula: string;
}

/**
 * What carrying this balance *would* cost, by the daily-periodic-rate method US
 * issuers use. `apr` is a percentage (19.99), matching `liabilities.apr`.
 *
 * A projection, never a record of what happened — the name says so because the
 * old one ("interestAccrued") read like an observation and was used as one. It
 * reported $27.40 of interest for a month on a card that was paid in full and
 * charged nothing, because a formula over balance and APR cannot see a grace
 * period. Only the statement knows what was charged.
 *
 * Legitimate uses: showing the owner what revolving a balance would cost them,
 * and comparing that against paying it down. Never for recording a cost that
 * has already been incurred — read the interest charges for that.
 */
export function projectInterest(balance: number, apr: number, days: number): InterestProjection {
  const dailyRate = apr / 100 / 365;
  const interest = round2(balance * dailyRate * days);
  return {
    balance: round2(balance),
    apr_percent: apr,
    days,
    daily_rate: dailyRate,
    interest,
    formula: `${round2(balance)} × (${apr}% ÷ 365) × ${days} days = ${interest}`,
  };
}

export const GOAL_TYPES: { value: GoalType; label: string; hint: string }[] = [
  { value: "emergency_fund", label: "Emergency fund", hint: "months of expenses set aside" },
  { value: "debt_payoff", label: "Debt payoff", hint: "clear a balance by a date" },
  { value: "savings_target", label: "Savings target", hint: "a number to reach" },
  { value: "investment_target", label: "Investment target", hint: "portfolio contribution goal" },
  { value: "custom", label: "Custom", hint: "anything else" },
];

export const LINK_ROLES: { value: LinkRole; label: string; hint: string }[] = [
  { value: "funding", label: "Funding account", hint: "where this goal's money lives" },
  {
    value: "contribution_source",
    label: "Counts as contribution",
    hint: "categories, tags or accounts whose spending pays into this goal",
  },
  {
    value: "cost_driver",
    label: "Cost driver",
    hint: "liabilities and recurring items whose cost is charged against this goal",
  },
  { value: "constraint", label: "Constraint", hint: "must not be touched to fund this goal" },
];

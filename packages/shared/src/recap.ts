/**
 * Recap math and the grounding verifier (spec §5.9, Phase 2 flagship).
 *
 * Stage 1 is deterministic: every number a recap can contain is computed here,
 * by code, and stored. Stage 2 (the LLM) may only *reference* those numbers —
 * `verifyGrounding` is what makes that a checked rule rather than a hope.
 */

import { round2, type CategoryIndex, type ReportTxn } from "./reports";
import { summarize } from "./reports";
import { interestAccrued, type InterestComputation } from "./goals";

// ---------------------------------------------------------------------------
// period windows
// ---------------------------------------------------------------------------

export interface Window {
  start: string;
  end: string;
  days: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The completed Mon–Sun week containing `ref` minus one week. */
export function lastWeekWindow(ref = new Date()): Window {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = new Date(d.getTime() - dow * 86400_000);
  const start = new Date(thisMonday.getTime() - 7 * 86400_000);
  const end = new Date(thisMonday.getTime() - 86400_000);
  return { start: iso(start), end: iso(end), days: 7 };
}

/** The completed calendar month before `ref`. */
export function lastMonthWindow(ref = new Date()): Window {
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 0));
  return {
    start: iso(start),
    end: iso(end),
    days: Math.round((end.getTime() - start.getTime()) / 86400_000) + 1,
  };
}

/**
 * What "the prior period" means for a recap.
 *
 * A monthly recap compares against the previous *calendar* month, not the
 * previous 31 days — otherwise a 31-day July compares against a window that
 * reaches back into May, and "last month" in the narrative means something the
 * owner cannot check against a statement.
 */
export function priorWindowFor(periodType: "weekly" | "monthly", w: Window): Window {
  if (periodType === "weekly") return precedingWindow(w);
  const start = new Date(`${w.start}T00:00:00Z`);
  const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const prevEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0));
  return {
    start: iso(prevStart),
    end: iso(prevEnd),
    days: Math.round((prevEnd.getTime() - prevStart.getTime()) / 86400_000) + 1,
  };
}

/** The window of the same length immediately before `w`. */
export function precedingWindow(w: Window): Window {
  const start = new Date(`${w.start}T00:00:00Z`);
  const end = new Date(start.getTime() - 86400_000);
  const prevStart = new Date(end.getTime() - (w.days - 1) * 86400_000);
  return { start: iso(prevStart), end: iso(end), days: w.days };
}

// ---------------------------------------------------------------------------
// Stage 1 fact shapes
// ---------------------------------------------------------------------------

export interface CashFlowFacts {
  income: number;
  expense: number;
  net: number;
  savings_rate_pct: number | null;
  transaction_count: number;
  prior_income: number;
  prior_expense: number;
  prior_net: number;
  income_delta: number;
  expense_delta: number;
  net_delta: number;
  expense_change_pct: number | null;
  top_groups: { name: string; amount: number; share_pct: number }[];
  biggest_movers: { name: string; amount: number; prior: number; delta: number }[];
  top_merchants: { name: string; amount: number; count: number }[];
}

export interface BudgetFacts {
  month: string | null;
  budgeted_total: number;
  spent_total: number;
  variance: number;
  adherence_pct: number | null;
  lines_over: { category: string; budget: number; spent: number; over_by: number }[];
  lines_under: { category: string; budget: number; spent: number; under_by: number }[];
  categories_tracked: number;
}

export interface CreditFacts {
  total_balance: number;
  total_limit: number;
  utilization_pct: number | null;
  cards: {
    account_last4: string | null;
    balance: number;
    limit: number | null;
    utilization_pct: number | null;
    apr_pct: number | null;
  }[];
}

export interface GoalCostFact {
  goal_id: string;
  goal_name: string;
  contributed: number;
  contribution_txn_ids: string[];
  costs: {
    cost_type: string;
    amount: number;
    liability_last4: string | null;
    computation: InterestComputation | Record<string, unknown>;
    narrative: string;
    contributing_txn_ids: string[];
  }[];
  total_cost: number;
  net_efficiency: number;
  cost_per_dollar_pct: number | null;
  target_amount: number | null;
  current_amount: number;
  pace_status: string;
}

export interface SubscriptionFact {
  recurring_item_id: string;
  merchant: string;
  cadence: string | null;
  expected_amount: number | null;
  observed_amounts: number[];
  observed_monthly_cost: number | null;
  last_charge_date: string | null;
  status: string;
  purpose: string | null;
  value_notes: string | null;
  overlap_tags: string[];
}

export interface Stage1Facts {
  period_type: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  days: number;
  prior_period_start: string;
  prior_period_end: string;
  cash_flow: CashFlowFacts;
  budget: BudgetFacts;
  credit: CreditFacts;
  goals: GoalCostFact[];
  net_worth: { start: number | null; end: number | null; change: number | null };
  subscriptions: SubscriptionFact[];
  prior_recaps: { period_start: string; overall_score: number | null; scores: unknown }[];
}

// ---------------------------------------------------------------------------
// Stage 1 computations
// ---------------------------------------------------------------------------

const pct = (n: number, d: number): number | null => (d ? Math.round((n / d) * 1000) / 10 : null);

export function computeCashFlow(
  current: ReportTxn[],
  prior: ReportTxn[],
  cats: CategoryIndex
): CashFlowFacts {
  const cur = summarize(current, cats, { topMerchants: 8 });
  const pre = summarize(prior, cats);
  const priorByGroup = new Map(pre.expenseGroups.map((g) => [g.name, g.total]));

  const movers = cur.expenseGroups
    .map((g) => {
      const p = priorByGroup.get(g.name) ?? 0;
      return { name: g.name, amount: g.total, prior: round2(p), delta: round2(g.total - p) };
    })
    .concat(
      pre.expenseGroups
        .filter((g) => !cur.expenseGroups.some((c) => c.name === g.name))
        .map((g) => ({ name: g.name, amount: 0, prior: g.total, delta: round2(-g.total) }))
    )
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 6);

  return {
    income: cur.income,
    expense: cur.expense,
    net: cur.net,
    savings_rate_pct: cur.savingsRate != null ? Math.round(cur.savingsRate * 1000) / 10 : null,
    transaction_count: cur.txnCount,
    prior_income: pre.income,
    prior_expense: pre.expense,
    prior_net: pre.net,
    income_delta: round2(cur.income - pre.income),
    expense_delta: round2(cur.expense - pre.expense),
    net_delta: round2(cur.net - pre.net),
    expense_change_pct: pre.expense ? Math.round(((cur.expense - pre.expense) / pre.expense) * 1000) / 10 : null,
    top_groups: cur.expenseGroups.slice(0, 8).map((g) => ({
      name: g.name,
      amount: g.total,
      share_pct: pct(g.total, cur.expense) ?? 0,
    })),
    biggest_movers: movers,
    top_merchants: cur.topMerchants.map((m) => ({ name: m.name, amount: m.total, count: m.count })),
  };
}

export interface BudgetLineInput {
  category_id: string | null;
  category_name: string;
  amount: number;
  rollover_in: number;
}

export function computeBudget(
  month: string | null,
  lines: BudgetLineInput[],
  spentByCategory: Map<string, number>
): BudgetFacts {
  let budgeted = 0;
  let spent = 0;
  const over: BudgetFacts["lines_over"] = [];
  const under: BudgetFacts["lines_under"] = [];

  for (const line of lines) {
    const allowed = Number(line.amount) + Number(line.rollover_in);
    const actual = line.category_id ? (spentByCategory.get(line.category_id) ?? 0) : 0;
    budgeted += allowed;
    spent += actual;
    const diff = round2(actual - allowed);
    if (diff > 0) {
      over.push({ category: line.category_name, budget: round2(allowed), spent: round2(actual), over_by: diff });
    } else if (allowed > 0) {
      under.push({
        category: line.category_name,
        budget: round2(allowed),
        spent: round2(actual),
        under_by: round2(-diff),
      });
    }
  }

  return {
    month,
    budgeted_total: round2(budgeted),
    spent_total: round2(spent),
    variance: round2(budgeted - spent),
    adherence_pct: budgeted ? Math.round((spent / budgeted) * 1000) / 10 : null,
    lines_over: over.sort((a, b) => b.over_by - a.over_by).slice(0, 8),
    lines_under: under.sort((a, b) => b.under_by - a.under_by).slice(0, 8),
    categories_tracked: lines.length,
  };
}

export interface CreditAccountInput {
  mask: string | null;
  current_balance: number | null;
  available_balance: number | null;
  apr: number | null;
}

export function computeCredit(accounts: CreditAccountInput[]): CreditFacts {
  const cards = accounts.map((a) => {
    const balance = Math.abs(Number(a.current_balance ?? 0));
    // Plaid gives available credit, not the limit — the limit is the sum.
    const limit = a.available_balance != null ? round2(balance + Math.abs(Number(a.available_balance))) : null;
    return {
      account_last4: a.mask,
      balance: round2(balance),
      limit,
      utilization_pct: limit ? pct(balance, limit) : null,
      apr_pct: a.apr != null ? Number(a.apr) : null,
    };
  });

  const totalBalance = round2(cards.reduce((s, c) => s + c.balance, 0));
  const totalLimit = round2(cards.reduce((s, c) => s + (c.limit ?? 0), 0));
  return {
    total_balance: totalBalance,
    total_limit: totalLimit,
    utilization_pct: totalLimit ? pct(totalBalance, totalLimit) : null,
    cards,
  };
}

export interface GoalCostInput {
  goal: {
    id: string;
    name: string;
    target_amount: number | null;
    current_amount: number;
    pace_status: string;
  };
  contributions: { transaction_id: string | null; amount: number; date: string }[];
  costDrivers: {
    liability_id: string;
    account_last4: string | null;
    balance: number | null;
    apr: number | null;
  }[];
  days: number;
}

/**
 * Attribute period costs to a goal.
 *
 * The attribution rule, stated plainly: interest accrued on a linked liability
 * during the period is charged against the goal only if the owner *also*
 * contributed to the goal during that period. Paying into savings while
 * carrying a balance is the tradeoff being measured; carrying a balance while
 * contributing nothing is a credit problem, not a goal cost.
 */
export function computeGoalCosts(input: GoalCostInput): GoalCostFact {
  const contributed = round2(input.contributions.reduce((s, c) => s + Number(c.amount), 0));
  const txnIds = input.contributions
    .map((c) => c.transaction_id)
    .filter((id): id is string => Boolean(id));

  const costs: GoalCostFact["costs"] = [];
  if (contributed > 0) {
    for (const d of input.costDrivers) {
      const balance = Number(d.balance ?? 0);
      const apr = Number(d.apr ?? 0);
      if (balance <= 0 || apr <= 0) continue;
      const computation = interestAccrued(balance, apr, input.days);
      costs.push({
        cost_type: "interest_accrued",
        amount: computation.interest,
        liability_last4: d.account_last4,
        computation,
        narrative: `Carried ${computation.balance} on the card ending ${
          d.account_last4 ?? "—"
        } for ${input.days} days at ${apr}% APR while contributing ${contributed} to this goal.`,
        contributing_txn_ids: txnIds,
      });
    }
  }

  const totalCost = round2(costs.reduce((s, c) => s + c.amount, 0));
  return {
    goal_id: input.goal.id,
    goal_name: input.goal.name,
    contributed,
    contribution_txn_ids: txnIds,
    costs,
    total_cost: totalCost,
    net_efficiency: round2(contributed - totalCost),
    cost_per_dollar_pct: contributed > 0 ? Math.round((totalCost / contributed) * 1000) / 10 : null,
    target_amount: input.goal.target_amount,
    current_amount: round2(Number(input.goal.current_amount)),
    pace_status: input.goal.pace_status,
  };
}

// ---------------------------------------------------------------------------
// Grounding verifier — the rule that makes Stage 2 trustworthy
// ---------------------------------------------------------------------------

/** Every number appearing anywhere in the Stage 1 facts, recursively. */
export function collectNumbers(value: unknown, into = new Set<number>()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.add(value);
    into.add(Math.round(value));
    into.add(Math.round(value * 10) / 10);
    into.add(Math.abs(value));
    into.add(Math.round(Math.abs(value)));
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, into);
  } else if (typeof value === "string") {
    // Numbers embedded in Stage 1 narrative strings (the interest formula) count
    // as sourced — code wrote them.
    for (const m of value.matchAll(/-?\d[\d,]*\.?\d*/g)) {
      const n = Number(m[0].replace(/,/g, ""));
      if (Number.isFinite(n)) {
        into.add(n);
        into.add(Math.round(n));
        into.add(Math.round(n * 10) / 10);
      }
    }
  }
  return into;
}

export interface GroundingResult {
  ok: boolean;
  offenders: { value: number; context: string }[];
  checked: number;
}

const NUMBER_RE = /-?\$?\s?\d[\d,]*(?:\.\d+)?%?/g;

/**
 * Reject any figure in the model's prose that Stage 1 did not produce.
 *
 * Allowances are deliberately narrow: scores 0–100 (the model's own output),
 * four-digit years, and small counts up to 12 (ordinals like "3 goals", "6
 * months") — everything else must match a Stage 1 number within a cent or a
 * rounding step.
 */
export function verifyGrounding(
  texts: string[],
  facts: unknown,
  extraAllowed: number[] = []
): GroundingResult {
  const allowed = collectNumbers(facts);
  for (const n of extraAllowed) {
    allowed.add(n);
    allowed.add(Math.round(n));
    allowed.add(Math.round(n * 10) / 10);
  }

  const offenders: GroundingResult["offenders"] = [];
  let checked = 0;

  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(NUMBER_RE)) {
      const raw = match[0];
      const n = Number(raw.replace(/[$,%\s]/g, ""));
      if (!Number.isFinite(n)) continue;
      checked++;

      const isScore = Number.isInteger(n) && n >= 0 && n <= 100;
      const isYear = Number.isInteger(n) && n >= 1900 && n <= 2100;
      const isSmallCount = Number.isInteger(n) && n >= 0 && n <= 12;
      if (isScore || isYear || isSmallCount) continue;

      // Compared on magnitude, not sign. A hyphen in prose is usually a range
      // ("$1,510.25-$1,240.00"), and the regex reads the second figure as
      // negative — which failed a run over a number that was in the facts all
      // along. Sign is ambiguous here anyway: the platform stores outflows
      // positive, so the same dollar legitimately appears either way. What
      // grounding checks is whether the figure exists, not which way it points.
      const magnitude = Math.abs(n);
      const grounded = [...allowed].some(
        (a) => Math.abs(Math.abs(a) - magnitude) <= Math.max(0.011, Math.abs(a) * 0.005)
      );
      if (!grounded) {
        const at = match.index ?? 0;
        offenders.push({
          value: n,
          context: text.slice(Math.max(0, at - 40), at + raw.length + 40).replace(/\s+/g, " "),
        });
      }
    }
  }

  return { ok: offenders.length === 0, offenders, checked };
}

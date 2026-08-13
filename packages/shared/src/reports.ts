/**
 * Report aggregation math (spec §5 "Reports").
 *
 * Every function here is pure and browser-safe — no node:crypto, no DB client —
 * so the web app can deep-import it (`@finance/shared/src/reports`) and the
 * workers can reuse the same math for recaps. Keeping it out of the components
 * is deliberate: these numbers get hand-checked against SQL, and later the recap
 * engine has to produce the *same* figures the UI shows.
 *
 * Sign convention is Plaid's, used everywhere in this codebase:
 *   amount > 0  => money left the account (outflow / spending)
 *   amount < 0  => money arrived (inflow / income, refunds)
 */

export type FlowType = "income" | "expense" | "transfer";

export interface ReportTxn {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number;
  merchant: string | null;
  merchant_clean?: string | null;
  category_id: string | null;
  account_id: string;
  is_business?: boolean;
  business_entity?: string | null;
  pending?: boolean;
}

export interface CategoryMeta {
  id: string;
  name: string;
  emoji: string | null;
  group_id: string;
  group_name: string;
  group_type: FlowType;
}

/** Stand-in bucket for transactions the pipeline could not categorize. */
export const UNCATEGORIZED_KEY = "uncategorized";
export const OTHER_KEY = "__other__";

export type CategoryIndex = Map<string, CategoryMeta>;

export function indexCategories(cats: CategoryMeta[]): CategoryIndex {
  return new Map(cats.map((c) => [c.id, c]));
}

/**
 * Which side of the cash-flow statement a transaction sits on. Category group
 * type wins when we know it; otherwise the sign decides, so an uncategorized
 * paycheck still reads as income rather than negative spending.
 */
export function flowOf(txn: ReportTxn, cats: CategoryIndex): FlowType {
  const cat = txn.category_id ? cats.get(txn.category_id) : undefined;
  if (cat) return cat.group_type;
  return txn.amount < 0 ? "income" : "expense";
}

/** Positive magnitude on the side the transaction belongs to. */
export function magnitude(txn: ReportTxn, flow: FlowType): number {
  return flow === "income" ? -Number(txn.amount) : Number(txn.amount);
}

export interface Slice {
  key: string;
  name: string;
  emoji?: string | null;
  total: number;
  count: number;
  share: number; // of its side's total, 0..1
}

export interface GroupSlice extends Slice {
  type: FlowType;
  categories: Slice[];
}

export interface Summary {
  income: number;
  expense: number;
  net: number;
  /** net / income, clamped to null when there was no income to save out of. */
  savingsRate: number | null;
  transfers: number;
  txnCount: number;
  incomeGroups: GroupSlice[];
  expenseGroups: GroupSlice[];
  topMerchants: Slice[];
}

interface Bucket {
  key: string;
  name: string;
  emoji?: string | null;
  type: FlowType;
  total: number;
  count: number;
  cats: Map<string, { name: string; emoji: string | null; total: number; count: number }>;
}

/**
 * Roll a transaction list into totals by group and category.
 * Transfers are tallied but never enter income/expense — moving your own money
 * is not cash flow, and counting it double-inflates both sides.
 */
export function summarize(
  txns: ReportTxn[],
  cats: CategoryIndex,
  opts: { topMerchants?: number } = {}
): Summary {
  const groups = new Map<string, Bucket>();
  let income = 0;
  let expense = 0;
  let transfers = 0;
  const merchants = new Map<string, { total: number; count: number }>();

  for (const txn of txns) {
    const flow = flowOf(txn, cats);
    const amount = magnitude(txn, flow);
    const cat = txn.category_id ? cats.get(txn.category_id) : undefined;

    if (flow === "transfer") {
      transfers += Math.abs(amount);
      continue;
    }
    if (flow === "income") income += amount;
    else expense += amount;

    const groupKey = cat ? cat.group_id : `${UNCATEGORIZED_KEY}:${flow}`;
    const groupName = cat ? cat.group_name : "Uncategorized";
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = { key: groupKey, name: groupName, type: flow, total: 0, count: 0, cats: new Map() };
      groups.set(groupKey, bucket);
    }
    bucket.total += amount;
    bucket.count += 1;

    const catKey = cat ? cat.id : `${UNCATEGORIZED_KEY}:${flow}`;
    const catName = cat ? cat.name : "Uncategorized";
    let leaf = bucket.cats.get(catKey);
    if (!leaf) {
      leaf = { name: catName, emoji: cat?.emoji ?? null, total: 0, count: 0 };
      bucket.cats.set(catKey, leaf);
    }
    leaf.total += amount;
    leaf.count += 1;

    if (flow === "expense") {
      const name = txn.merchant_clean || txn.merchant || "Unknown";
      const m = merchants.get(name) ?? { total: 0, count: 0 };
      m.total += amount;
      m.count += 1;
      merchants.set(name, m);
    }
  }

  const build = (type: FlowType, sideTotal: number): GroupSlice[] =>
    [...groups.values()]
      .filter((g) => g.type === type)
      .map((g) => ({
        key: g.key,
        name: g.name,
        type,
        total: round2(g.total),
        count: g.count,
        share: sideTotal ? g.total / sideTotal : 0,
        categories: [...g.cats.entries()]
          .map(([key, c]) => ({
            key,
            name: c.name,
            emoji: c.emoji,
            total: round2(c.total),
            count: c.count,
            share: g.total ? c.total / g.total : 0,
          }))
          .sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => b.total - a.total);

  return {
    income: round2(income),
    expense: round2(expense),
    net: round2(income - expense),
    savingsRate: income > 0 ? (income - expense) / income : null,
    transfers: round2(transfers),
    txnCount: txns.length,
    incomeGroups: build("income", income),
    expenseGroups: build("expense", expense),
    topMerchants: [...merchants.entries()]
      .map(([name, m]) => ({
        key: name,
        name,
        total: round2(m.total),
        count: m.count,
        share: expense ? m.total / expense : 0,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, opts.topMerchants ?? 10),
  };
}

// ---------------------------------------------------------------------------
// Cash-flow Sankey model (spec §5.8: income sources → category groups → categories)
// ---------------------------------------------------------------------------

export interface SankeyNode {
  id: string;
  name: string;
  value: number;
  column: 0 | 1 | 2 | 3;
  /** Index into the categorical palette; -1 means "use the muted slot". */
  hue: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  hue: number;
}

export interface SankeyModel {
  nodes: SankeyNode[];
  links: SankeyLink[];
  income: number;
  expense: number;
  net: number;
}

export interface SankeyOptions {
  /** Distinct income sources drawn before the rest folds into "Other income". */
  maxIncome?: number;
  /** Distinct spending groups drawn before the rest folds into "Other". */
  maxGroups?: number;
  /** Categories drawn inside each group before the rest folds into "Other". */
  maxCategories?: number;
  /** Hues available; anything past this folds to the muted slot. */
  hueCount?: number;
}

/**
 * Four columns: income sources → a "Cash in" hub → spending groups → categories.
 *
 * The hub is not decoration. Dollars are fungible: nothing in the data says
 * which paycheck paid the electric bill, so drawing income sources straight
 * into spending groups would invent an attribution we do not have. The hub says
 * "everything pools here, then goes out", which is the true statement.
 */
export function buildCashFlowSankey(
  txns: ReportTxn[],
  cats: CategoryIndex,
  opts: SankeyOptions = {}
): SankeyModel {
  const maxIncome = opts.maxIncome ?? 6;
  const maxGroups = opts.maxGroups ?? 8;
  const maxCategories = opts.maxCategories ?? 6;
  const hueCount = opts.hueCount ?? 8;

  const s = summarize(txns, cats);
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];

  // Income sources are categories, not groups — "Paycheck" is more useful than
  // the group it happens to live in.
  const incomeCats = s.incomeGroups
    .flatMap((g) => g.categories)
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
  const shownIncome = incomeCats.slice(0, maxIncome);
  const restIncome = incomeCats.slice(maxIncome);

  let hue = 0;
  const nextHue = () => (hue < hueCount ? hue++ : -1);

  const HUB = "hub:cash-in";
  nodes.push({ id: HUB, name: "Cash in", value: round2(s.income), column: 1, hue: -1 });

  for (const c of shownIncome) {
    const id = `in:${c.key}`;
    const h = nextHue();
    nodes.push({ id, name: c.name, value: c.total, column: 0, hue: h });
    links.push({ source: id, target: HUB, value: c.total, hue: h });
  }
  if (restIncome.length) {
    const total = round2(restIncome.reduce((sum, c) => sum + c.total, 0));
    if (total > 0) {
      nodes.push({ id: "in:other", name: `Other income (${restIncome.length})`, value: total, column: 0, hue: -1 });
      links.push({ source: "in:other", target: HUB, value: total, hue: -1 });
    }
  }

  const spendGroups = s.expenseGroups.filter((g) => g.total > 0);
  const shownGroups = spendGroups.slice(0, maxGroups);
  const restGroups = spendGroups.slice(maxGroups);

  for (const g of shownGroups) {
    const gid = `grp:${g.key}`;
    const h = nextHue();
    nodes.push({ id: gid, name: g.name, value: g.total, column: 2, hue: h });
    links.push({ source: HUB, target: gid, value: g.total, hue: h });

    const shownCats = g.categories.filter((c) => c.total > 0).slice(0, maxCategories);
    const restCats = g.categories.filter((c) => c.total > 0).slice(maxCategories);
    // A group with one category would just draw the same bar twice.
    if (shownCats.length > 1 || restCats.length) {
      for (const c of shownCats) {
        const cid = `cat:${c.key}`;
        nodes.push({ id: cid, name: c.name, value: c.total, column: 3, hue: h });
        links.push({ source: gid, target: cid, value: c.total, hue: h });
      }
      if (restCats.length) {
        const total = round2(restCats.reduce((sum, c) => sum + c.total, 0));
        const cid = `cat:${g.key}:other`;
        nodes.push({ id: cid, name: `Other (${restCats.length})`, value: total, column: 3, hue: h });
        links.push({ source: gid, target: cid, value: total, hue: h });
      }
    }
  }

  if (restGroups.length) {
    const total = round2(restGroups.reduce((sum, g) => sum + g.total, 0));
    if (total > 0) {
      nodes.push({ id: "grp:other", name: `Other spending (${restGroups.length})`, value: total, column: 2, hue: -1 });
      links.push({ source: HUB, target: "grp:other", value: total, hue: -1 });
    }
  }

  // Surplus leaves the hub as its own flow so the diagram balances; a deficit
  // is drawn as an inflow instead, because that month you spent savings.
  if (s.net > 0) {
    nodes.push({ id: "net:saved", name: "Left over", value: s.net, column: 2, hue: -2 });
    links.push({ source: HUB, target: "net:saved", value: s.net, hue: -2 });
  } else if (s.net < 0) {
    const gap = round2(-s.net);
    nodes.push({ id: "net:gap", name: "From savings", value: gap, column: 0, hue: -2 });
    links.push({ source: "net:gap", target: HUB, value: gap, hue: -2 });
    const hub = nodes.find((n) => n.id === HUB)!;
    hub.value = round2(s.income + gap);
  }

  return { nodes, links, income: s.income, expense: s.expense, net: s.net };
}

// ---------------------------------------------------------------------------
// Time series (MoM / YoY)
// ---------------------------------------------------------------------------

import {
  attributionMonthOf,
  isShiftableIncome,
  CALENDAR_ATTRIBUTION,
  type IncomeAttribution,
} from "./pay-period";

export interface MonthPoint {
  month: string; // YYYY-MM
  income: number;
  expense: number;
  net: number;
  count: number;
}

export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * Dense monthly series — months with no activity still appear, as zeroes.
 *
 * `attribution` decides which month a paycheque counts toward. Left off, every
 * transaction falls in the month it posted, which is what a bank statement
 * shows. Passed the owner's forward_shift setting, earned income landing at
 * month end counts toward the month it pays for — and it has to be passed here
 * as well as on the Budget page, or the same payroll deposit sits in July on
 * one screen and August on another.
 */
export function monthlySeries(
  txns: ReportTxn[],
  cats: CategoryIndex,
  range?: { from: string; to: string },
  attribution: IncomeAttribution = CALENDAR_ATTRIBUTION
): MonthPoint[] {
  const map = new Map<string, MonthPoint>();
  const touch = (key: string) => {
    let p = map.get(key);
    if (!p) {
      p = { month: key, income: 0, expense: 0, net: 0, count: 0 };
      map.set(key, p);
    }
    return p;
  };

  for (const txn of txns) {
    const flow = flowOf(txn, cats);
    if (flow === "transfer") continue;
    // Only earned income shifts: a refund reverses a purchase and belongs to
    // the month it reverses, so isShiftableIncome decides per category.
    const catName = txn.category_id ? cats.get(txn.category_id)?.name : undefined;
    const shiftable = flow === "income" && isShiftableIncome(catName);
    const p = touch(attributionMonthOf(txn.date, shiftable, attribution));
    const amount = magnitude(txn, flow);
    if (flow === "income") p.income += amount;
    else p.expense += amount;
    p.count += 1;
  }

  if (range) {
    for (const key of monthsBetween(range.from, range.to)) touch(key);
  }

  return [...map.values()]
    .map((p) => ({
      ...p,
      income: round2(p.income),
      expense: round2(p.expense),
      net: round2(p.income - p.expense),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  for (let d = start; d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export interface GroupDelta {
  key: string;
  name: string;
  current: number;
  prior: number;
  delta: number;
  pct: number | null; // null when the prior period was zero
}

/** Per-group comparison of two summaries (this month vs last, or vs last year). */
export function compareGroups(current: GroupSlice[], prior: GroupSlice[]): GroupDelta[] {
  const priorByKey = new Map(prior.map((g) => [g.key, g.total]));
  const keys = new Set([...current.map((g) => g.key), ...prior.map((g) => g.key)]);
  const nameByKey = new Map([...prior, ...current].map((g) => [g.key, g.name]));

  return [...keys]
    .map((key) => {
      const cur = current.find((g) => g.key === key)?.total ?? 0;
      const pri = priorByKey.get(key) ?? 0;
      return {
        key,
        name: nameByKey.get(key) ?? key,
        current: round2(cur),
        prior: round2(pri),
        delta: round2(cur - pri),
        pct: pri !== 0 ? (cur - pri) / Math.abs(pri) : null,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ---------------------------------------------------------------------------
// Custom report builder (saved_reports.config)
// ---------------------------------------------------------------------------

export interface ReportFilter {
  from?: string;
  to?: string;
  /** Relative window used when from/to are absent — keeps saved reports live. */
  window?: string;
  accountIds?: string[];
  categoryIds?: string[];
  groupIds?: string[];
  tagIds?: string[];
  merchant?: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  flow?: FlowType | "all";
  business?: "all" | "business" | "personal";
  businessEntity?: string | null;
  includeHidden?: boolean;
  includePending?: boolean;
}

export function filterTxns(
  txns: ReportTxn[],
  cats: CategoryIndex,
  f: ReportFilter,
  tagsByTxn?: Map<string, Set<string>>
): ReportTxn[] {
  const merchant = f.merchant?.trim().toLowerCase();

  return txns.filter((t) => {
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.accountIds?.length && !f.accountIds.includes(t.account_id)) return false;
    if (f.categoryIds?.length && !(t.category_id && f.categoryIds.includes(t.category_id))) return false;
    if (f.groupIds?.length) {
      const cat = t.category_id ? cats.get(t.category_id) : undefined;
      if (!cat || !f.groupIds.includes(cat.group_id)) return false;
    }
    if (f.tagIds?.length) {
      const tags = tagsByTxn?.get(t.id);
      if (!tags || !f.tagIds.some((id) => tags.has(id))) return false;
    }
    if (merchant) {
      const hay = `${t.merchant_clean ?? ""} ${t.merchant ?? ""}`.toLowerCase();
      if (!hay.includes(merchant)) return false;
    }
    if (f.flow && f.flow !== "all" && flowOf(t, cats) !== f.flow) return false;
    if (f.business === "business" && !t.is_business) return false;
    if (f.business === "personal" && t.is_business) return false;
    if (f.businessEntity && t.business_entity !== f.businessEntity) return false;
    if (!f.includePending && t.pending) return false;

    const abs = Math.abs(Number(t.amount));
    if (f.minAmount != null && abs < f.minAmount) return false;
    if (f.maxAmount != null && abs > f.maxAmount) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function fmtMoney(n: number, opts: { cents?: boolean } = {}): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

export function fmtPct(n: number | null, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

/** CSV with the quoting the accountant's spreadsheet actually needs. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell == null) return "";
          const s = String(cell);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",")
    )
    .join("\n");
}

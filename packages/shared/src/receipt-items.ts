// Item-level receipt splitting (spec §1.7): one Walmart charge is groceries and
// a toy and a bottle of shampoo, and filing the whole thing under one category
// makes the grocery budget a lie in both directions.
//
// The hard part is not the arithmetic, it is knowing when NOT to split. Real
// retailer mail is mostly incomplete: a Walmart delivery confirmation for a
// 21-item order names three of them and prices none, and pads the page with
// "Recently viewed items" that read exactly like real line items. A split built
// on that would be confidently wrong and would silently rewrite the books, so
// everything here is gated on coverage — how much of the charge the items we
// captured actually account for. Short of that bar we suggest and let the owner
// decide; we never write.
//
// Pure and browser-safe: the worker computes plans, the UI previews them.

/** Item categories the parser may choose from — deliberately few. */
export const ITEM_CATEGORIES = [
  "groceries",
  "restaurant",
  "alcohol",
  "pharmacy",
  "personal_care",
  "household",
  "clothing",
  "electronics",
  "toys_hobbies",
  "books",
  "pets",
  "baby_kids",
  "office_business",
  "other",
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * Item bucket -> the category name in `categories`. Several buckets collapse
 * onto one category on purpose: the split is only worth making where the
 * owner's budget actually distinguishes the spend.
 */
export const ITEM_CATEGORY_MAP: Record<ItemCategory, string> = {
  groceries: "Groceries",
  restaurant: "Restaurants",
  alcohol: "Alcohol & Bars",
  pharmacy: "Pharmacy",
  personal_care: "Personal Care",
  household: "Home Goods",
  clothing: "Clothing",
  electronics: "Electronics",
  toys_hobbies: "Hobbies",
  books: "Books",
  pets: "Pets",
  baby_kids: "Shopping",
  office_business: "Business Expense",
  other: "Shopping",
};

export interface ReceiptItem {
  description: string;
  /** null when the email names the item but never prices it (Walmart does this). */
  amount: number | null;
  qty: number | null;
  category: ItemCategory | null;
}

export interface ReceiptTotals {
  /** What the card was charged. The parent transaction's amount wins over this. */
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  /** How many items the email says the order contains ("21 items"), if stated. */
  itemCount: number | null;
}

export interface ItemCoverage {
  /** Item rows captured from the email. */
  named: number;
  /** Of those, how many carry a price. */
  priced: number;
  /** How many the email claims exist; falls back to `named` when unstated. */
  listed: number;
  /** Sum of the priced items. */
  sum: number;
  /** What that sum is measured against — subtotal if given, else total. */
  basis: number | null;
  /** sum / basis, 0 when there is nothing to measure. */
  ratio: number;
  /** Every claimed item was captured. */
  allNamed: boolean;
  /** Every captured item carries a price. */
  allPriced: boolean;
  /** Distinct categories across the captured items. */
  categories: ItemCategory[];
  /**
   * Safe to write a dollar split from: every item accounted for, every item
   * priced, and the prices add up to the charge.
   */
  complete: boolean;
}

/** Prices may miss the basis by this fraction and still count as adding up. */
const RATIO_TOLERANCE = 0.02;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function coverageOf(items: ReceiptItem[], totals: ReceiptTotals): ItemCoverage {
  const named = items.length;
  const pricedItems = items.filter((i) => i.amount != null && i.amount > 0);
  const sum = round2(pricedItems.reduce((s, i) => s + (i.amount ?? 0), 0));
  const basis = totals.subtotal ?? totals.total ?? null;
  const ratio = basis && basis > 0 ? sum / basis : 0;
  const listed = totals.itemCount != null && totals.itemCount > 0 ? totals.itemCount : named;

  const categories = [
    ...new Set(items.map((i) => i.category).filter((c): c is ItemCategory => c != null)),
  ];

  const allNamed = named > 0 && named >= listed;
  const allPriced = named > 0 && pricedItems.length === named;

  return {
    named,
    priced: pricedItems.length,
    listed,
    sum,
    basis,
    ratio,
    allNamed,
    allPriced,
    categories,
    complete:
      allNamed &&
      allPriced &&
      basis != null &&
      basis > 0 &&
      Math.abs(ratio - 1) <= RATIO_TOLERANCE,
  };
}

export interface SplitPart {
  category: ItemCategory;
  /** Category name to file the child under. */
  categoryName: string;
  amount: number;
  /** Item descriptions rolled into this part — for the UI, not for storage. */
  items: string[];
}

export interface SplitPlan {
  parts: SplitPart[];
  /** Charge the parts were allocated across (the bank amount, not the receipt). */
  total: number;
  /** Tax, fees and shipping spread across the parts, minus discounts. */
  overhead: number;
  coverage: ItemCoverage;
  /** True when the plan may be written without asking. */
  autoApplicable: boolean;
  /** Why it is suggestion-only, when it is. */
  reason: string | null;
}

/**
 * Build a split of `total` across the categories present in `items`.
 *
 * Items roll up to one child per category — a 22-item grocery run becomes two
 * or three children, not twenty-two rows nobody wants to read. Whatever the
 * items don't account for (tax, delivery, fees, less discounts) is spread
 * across the parts in proportion to their size, and the last cent of rounding
 * lands on the largest part so the children always sum to the parent exactly.
 */
export function planSplit(
  items: ReceiptItem[],
  totals: ReceiptTotals,
  total: number
): SplitPlan {
  const coverage = coverageOf(items, totals);
  const priced = items.filter((i) => i.amount != null && i.amount > 0 && i.category != null);

  const byCategory = new Map<ItemCategory, { amount: number; items: string[] }>();
  for (const item of priced) {
    const cat = item.category as ItemCategory;
    const entry = byCategory.get(cat) ?? { amount: 0, items: [] };
    entry.amount += item.amount ?? 0;
    entry.items.push(item.description);
    byCategory.set(cat, entry);
  }

  const itemsTotal = round2([...byCategory.values()].reduce((s, e) => s + e.amount, 0));
  const overhead = round2(total - itemsTotal);

  let parts: SplitPart[] = [...byCategory.entries()]
    .map(([category, entry]) => ({
      category,
      categoryName: ITEM_CATEGORY_MAP[category],
      // Proportional share of tax/fees/discounts. A discount makes `overhead`
      // negative, which is correct: everyone's share shrinks.
      amount: round2(
        entry.amount + (itemsTotal > 0 ? (entry.amount / itemsTotal) * overhead : 0)
      ),
      items: entry.items,
    }))
    .sort((a, b) => b.amount - a.amount);

  // Several categories can map onto the same category name (baby_kids and
  // other both file as Shopping); two children with the same category would be
  // noise, so merge them.
  const merged = new Map<string, SplitPart>();
  for (const part of parts) {
    const existing = merged.get(part.categoryName);
    if (existing) {
      existing.amount = round2(existing.amount + part.amount);
      existing.items.push(...part.items);
    } else {
      merged.set(part.categoryName, { ...part });
    }
  }
  parts = [...merged.values()].sort((a, b) => b.amount - a.amount);

  // Rounding residue onto the largest part, so the split balances to the cent.
  if (parts.length) {
    const drift = round2(total - parts.reduce((s, p) => s + p.amount, 0));
    if (drift !== 0) parts[0].amount = round2(parts[0].amount + drift);
  }

  // Ordered so the reason names the real obstacle: an email that priced
  // nothing also yields fewer than two parts, and "no prices" is the useful
  // half of that to show someone.
  let reason: string | null = null;
  if (!coverage.allNamed)
    reason = `email listed ${coverage.listed} items but named only ${coverage.named}`;
  else if (!coverage.allPriced)
    reason = `${coverage.named - coverage.priced} of ${coverage.named} items have no price`;
  else if (!coverage.complete)
    reason = `item prices cover ${(coverage.ratio * 100).toFixed(0)}% of the charge`;
  else if (parts.length < 2) reason = "items all fall in one category";
  else if (parts.some((p) => p.amount <= 0))
    reason = "a category came out at zero or negative after discounts";

  return {
    parts,
    total: round2(total),
    overhead,
    coverage,
    autoApplicable: reason == null,
    reason,
  };
}

/**
 * What gets written to `transactions.item_lines`: the basket, how much of the
 * charge it accounted for, and the plan — applied or merely offered.
 */
export interface StoredItemLines {
  source: "email_receipt";
  email_receipt_id: string;
  items: ReceiptItem[];
  coverage: ItemCoverage;
  plan: { parts: SplitPart[]; overhead: number; reason: string | null };
}

/**
 * The single-category answer: when every item in the basket belongs to one
 * category there is nothing to split, but the transaction is very likely
 * miscategorised — this is the Walmart-order-that-is-all-groceries case, and it
 * holds even when the email prices nothing.
 *
 * Returns the category only when the items we saw are the whole order. A
 * delivery notice naming 6 of 23 items tells you nothing about the other 17.
 */
export function unanimousCategory(
  items: ReceiptItem[],
  totals: ReceiptTotals
): { category: ItemCategory; categoryName: string } | null {
  const coverage = coverageOf(items, totals);
  if (!coverage.allNamed || coverage.categories.length !== 1) return null;
  if (items.some((i) => i.category == null)) return null;
  const category = coverage.categories[0];
  return { category, categoryName: ITEM_CATEGORY_MAP[category] };
}

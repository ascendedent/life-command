// Budget autofill math (spec §1.6, Monarch parity).
//
// Pulled out of the API route so it can be checked. "Budget math matches
// hand-checked figures including rollovers" is a Phase 2 acceptance criterion,
// and it cannot be hand-checked while it only exists inside an HTTP handler.

export interface BudgetableCategory {
  id: string;
  is_rollover: boolean;
  /** "income" | "expense" | "transfer" — transfers never get a budget line. */
  type: string;
}

export interface BudgetTxn {
  category_id: string | null;
  amount: number;
}

export interface PriorLine {
  category_id: string | null;
  amount: number;
  rollover_in: number;
}

export interface PlannedLine {
  category_id: string;
  amount: number;
  rollover_in: number;
}

/** Months of history the trailing average is taken over. */
export const AUTOFILL_MONTHS = 6;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Trailing per-category average, plus rollover carried in from last month.
 *
 * The average is over a fixed window, not over the months that happened to
 * have spending: a category hit once in six months budgets at a sixth of it,
 * which is the point — it is what you spend on it in a typical month.
 *
 * Rollover is last month's unspent remainder (budget + what rolled in, minus
 * what was spent), floored at zero. An overspend does not carry forward as a
 * debt; the overspend already showed up as an overspend.
 */
export function planBudgetLines(opts: {
  categories: BudgetableCategory[];
  /** Transactions in the trailing window, splits already resolved. */
  history: BudgetTxn[];
  /** Prior month's lines, if a prior budget exists. */
  priorLines?: PriorLine[] | null;
  /** Prior month's actual spend per category. */
  priorSpend?: Map<string, number>;
}): PlannedLine[] {
  const { categories, history, priorLines, priorSpend } = opts;
  const byId = new Map(categories.map((c) => [c.id, c]));

  const sums = new Map<string, number>();
  for (const t of history) {
    if (!t.category_id) continue;
    const cat = byId.get(t.category_id);
    if (!cat) continue;
    // Plaid convention: outflow positive, inflow negative. An income category
    // budgets what came in, so its sign flips.
    const contrib = cat.type === "income" ? -Number(t.amount) : Number(t.amount);
    if (contrib > 0) sums.set(t.category_id, (sums.get(t.category_id) ?? 0) + contrib);
  }

  return categories.map((c) => {
    const amount = round2((sums.get(c.id) ?? 0) / AUTOFILL_MONTHS);
    let rolloverIn = 0;
    if (c.is_rollover && priorLines) {
      const prev = priorLines.find((l) => l.category_id === c.id);
      if (prev) {
        rolloverIn = Math.max(
          0,
          Number(prev.amount) + Number(prev.rollover_in) - (priorSpend?.get(c.id) ?? 0)
        );
      }
    }
    return { category_id: c.id, amount, rollover_in: round2(rolloverIn) };
  });
}

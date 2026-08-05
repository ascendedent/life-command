// Which month a transaction counts toward.
//
// A paycheque landing on the 30th is spent on the month that is about to
// start. Filed under the month it posted, it inflates a month that is ending
// and leaves the next one looking like it began with nothing — one correct
// transaction making two months wrong.
//
// Only income moves. Shifting expenses too would just be redefining where the
// month boundary sits, which is a different feature and not what anyone means
// by "my pay period". An expense on the 30th was genuinely spent in that month.

/**
 * Income that is never shifted forward, even under forward_shift.
 *
 * A refund is a reversal of something you already bought, so it belongs to the
 * month it reverses, not to the one ahead. Interest and dividends are yield on
 * money already held rather than pay you are about to live on. What shifts is
 * earned income — and it is expressed as an exclusion rather than a list of pay
 * categories on purpose: on a real book the payroll deposit was filed under
 * "Other Income", so an allowlist of {Paycheck, Business Income} would have
 * shifted nothing at all and the setting would have looked broken.
 */
export const NEVER_SHIFTED_INCOME = new Set([
  "Refunds & Reimbursements",
  "Interest",
  "Dividends & Capital Gains",
]);

/** True when this income category represents pay that funds the month ahead. */
export function isShiftableIncome(categoryName: string | null | undefined): boolean {
  return !!categoryName && !NEVER_SHIFTED_INCOME.has(categoryName);
}

export type IncomeAttributionMode = "calendar" | "forward_shift";

export interface IncomeAttribution {
  mode: IncomeAttributionMode;
  /** Day of month from which income counts toward the following month. */
  shiftFromDay: number;
}

/** Calendar attribution — what a bank statement shows. */
export const CALENDAR_ATTRIBUTION: IncomeAttribution = {
  mode: "calendar",
  shiftFromDay: 26,
};

/** Read the owner's setting into the shape the pure functions want. */
export function attributionFrom(
  row: { income_attribution?: string | null; income_shift_from_day?: number | null } | null
): IncomeAttribution {
  const mode = row?.income_attribution === "forward_shift" ? "forward_shift" : "calendar";
  const day = Number(row?.income_shift_from_day ?? 26);
  return {
    mode,
    shiftFromDay: Number.isFinite(day) ? Math.min(31, Math.max(15, day)) : 26,
  };
}

/** "YYYY-MM" for a date string, with no shifting. */
export function calendarMonthOf(date: string): string {
  return String(date).slice(0, 7);
}

function nextMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12
    ? `${y + 1}-01`
    : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * The month this transaction should be counted in.
 *
 * `isIncome` is the caller's decision, because only the caller knows how flow
 * is determined in its context — a category group in reports, a sign in the
 * agent snapshot. Everything that is not income is returned unshifted.
 */
export function attributionMonthOf(
  date: string,
  isIncome: boolean,
  cfg: IncomeAttribution = CALENDAR_ATTRIBUTION
): string {
  const key = calendarMonthOf(date);
  if (cfg.mode !== "forward_shift" || !isIncome) return key;
  const day = Number(String(date).slice(8, 10));
  if (!Number.isFinite(day) || day < cfg.shiftFromDay) return key;
  return nextMonth(key);
}

/**
 * The date range that feeds a given attribution month.
 *
 * Under forward_shift an income query for March must reach back into the tail
 * of February, and must stop before the tail of March. Callers that filter
 * rows in SQL need this; callers that already hold the rows can just use
 * `attributionMonthOf`.
 */
export function incomeWindowFor(
  monthKey: string,
  cfg: IncomeAttribution = CALENDAR_ATTRIBUTION
): { from: string; to: string } {
  const [y, m] = monthKey.split("-").map(Number);
  const monthStart = `${monthKey}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
  if (cfg.mode !== "forward_shift") return { from: monthStart, to: monthEnd };

  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const [py, pm] = prev.split("-").map(Number);
  const prevLastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  // Income for this month starts in the tail of last month and ends the day
  // before this month's own tail starts shifting to the next one.
  const from = `${prev}-${String(Math.min(cfg.shiftFromDay, prevLastDay)).padStart(2, "0")}`;
  const to = `${monthKey}-${String(Math.min(cfg.shiftFromDay - 1, lastDay)).padStart(2, "0")}`;
  return { from, to };
}

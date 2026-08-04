/** Named date windows shared by the Reports tabs and saved report configs. */

export type PeriodKind =
  | "this_month"
  | "last_month"
  | "last_3"
  | "last_6"
  | "ytd"
  | "last_12"
  | "custom";

export interface Period {
  kind: PeriodKind;
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  label: string;
}

export const PERIOD_LABELS: { kind: PeriodKind; label: string }[] = [
  { kind: "this_month", label: "This month" },
  { kind: "last_month", label: "Last month" },
  { kind: "last_3", label: "3 months" },
  { kind: "last_6", label: "6 months" },
  { kind: "ytd", label: "YTD" },
  { kind: "last_12", label: "12 months" },
  { kind: "custom", label: "Custom" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** Last day of the month `m` (0-based) in year `y`. */
export function endOfMonth(y: number, m: number): Date {
  return utc(y, m + 1, 0);
}

export function resolvePeriod(kind: PeriodKind, today = new Date()): Omit<Period, "kind"> {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const label = PERIOD_LABELS.find((p) => p.kind === kind)?.label ?? "Custom";

  switch (kind) {
    case "this_month":
      return { from: iso(utc(y, m, 1)), to: iso(endOfMonth(y, m)), label };
    case "last_month":
      return { from: iso(utc(y, m - 1, 1)), to: iso(endOfMonth(y, m - 1)), label };
    case "last_3":
      return { from: iso(utc(y, m - 2, 1)), to: iso(endOfMonth(y, m)), label };
    case "last_6":
      return { from: iso(utc(y, m - 5, 1)), to: iso(endOfMonth(y, m)), label };
    case "ytd":
      return { from: iso(utc(y, 0, 1)), to: iso(endOfMonth(y, m)), label };
    case "last_12":
      return { from: iso(utc(y, m - 11, 1)), to: iso(endOfMonth(y, m)), label };
    default:
      return { from: iso(utc(y, m, 1)), to: iso(endOfMonth(y, m)), label };
  }
}

/** Same-length window one year earlier, for YoY. */
export function priorYear(p: { from: string; to: string }): { from: string; to: string } {
  const shift = (s: string) => {
    const d = new Date(`${s}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  };
  return { from: shift(p.from), to: shift(p.to) };
}

/** Immediately preceding window of the same length, for period-over-period. */
export function priorPeriod(p: { from: string; to: string }): { from: string; to: string } {
  const from = new Date(`${p.from}T00:00:00Z`);
  const to = new Date(`${p.to}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86400_000) + 1;
  const priorTo = new Date(from.getTime() - 86400_000);
  const priorFrom = new Date(priorTo.getTime() - (days - 1) * 86400_000);
  return { from: priorFrom.toISOString().slice(0, 10), to: priorTo.toISOString().slice(0, 10) };
}

/** Earliest date any tab may need: the window, but never less than 25 months. */
export function fetchFloor(from: string, today = new Date()): string {
  const floor = utc(today.getUTCFullYear(), today.getUTCMonth() - 24, 1);
  const f = iso(floor);
  return from < f ? from : f;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

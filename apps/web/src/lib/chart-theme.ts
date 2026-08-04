/**
 * Chart palette for the dark command-center surface.
 *
 * These eight hues are assigned in this fixed order and never cycled — a ninth
 * series folds into "Other" (SERIES_MUTED). Validated against the card surface
 * #14181f with the dataviz palette validator: lightness band, chroma floor,
 * adjacent-pair CVD separation (worst 8.4 ΔE protan), normal-vision floor
 * (worst 19.3), and ≥3:1 contrast all pass. Re-run the validator before
 * touching any hex here.
 */
export const SERIES = [
  "#3987e5", // 1 blue
  "#d95926", // 2 orange
  "#199e70", // 3 aqua
  "#c98500", // 4 yellow
  "#d55181", // 5 magenta
  "#008300", // 6 green
  "#9085e9", // 7 violet
  "#e66767", // 8 red
] as const;

/** Ninth-and-beyond bucket. Deliberately hue-less so it reads as "the rest". */
export const SERIES_MUTED = "#7d8899";

/**
 * Fixed roles for the three flows that recur across every chart in the app, so
 * "income" is the same hue everywhere. Validated as a set (all-pairs, dark
 * surface): worst CVD ΔE 9.4, worst normal-vision ΔE 20.9, all ≥3:1.
 */
export const FLOW = {
  income: SERIES[2], // aqua
  spending: SERIES[1], // orange
  net: SERIES[0], // blue
} as const;

/** Reserved status colors — never used as a series. */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export const SURFACE = "#14181f";
export const GRID = "#232936";
export const TEXT_MUTED = "#7d8899";

/** hue index → hex. -1 = muted "other", -2 = surplus/deficit status slot. */
export function hueColor(hue: number, positive = true): string {
  if (hue === -2) return positive ? STATUS.good : STATUS.critical;
  if (hue < 0) return SERIES_MUTED;
  return SERIES[hue % SERIES.length];
}

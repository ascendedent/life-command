/**
 * Per-vendor receipt layout learning.
 *
 * A vendor's receipts share a layout, so the amount charged always sits behind
 * the same wording — "Order total", "Amount charged", "Grand Total". Asking a
 * model to re-read that layout on every email is wasteful and, worse,
 * non-deterministic: the same receipt can parse two ways on two days.
 *
 * So: the first receipt from a vendor is read by the model, and the label that
 * preceded the true total is captured *mechanically* from the model's answer —
 * no second model call, no guessing. Every later receipt from that vendor is
 * parsed by looking for that label. If the label stops matching (the vendor
 * redesigned their email), the template is marked failing and relearned.
 *
 * Pure functions only: no DB, no network, so the learning rule is testable.
 */

export interface ReceiptTemplate {
  vendor_key: string;
  vendor_name: string;
  total_label: string | null;
  last4_label: string | null;
  status?: string;
}

/**
 * Words that must never become a learned label — they name the wrong figure.
 * Note what is absent: "tax", "discount", "shipping". Those appear inside
 * perfectly correct total lines ("Order total — includes all fees, taxes and
 * discounts $35.60"), and excluding them refuses to learn the right answer.
 */
const BAD_LABEL =
  /(?:you\s+saved|saved\s+a\s+total|savings|cash\s?back|rewards?\b|\bpoints\b|\btip\b|\bbalance\b|estimated)/i;

/**
 * The wording a receipt uses to name the amount charged. Anchoring the learned
 * label on one of these beats grabbing whatever words happen to sit before the
 * number — "taxes and discounts" would technically match again next time, but
 * it is not what the vendor means by "the total".
 */
const TOTAL_PHRASE =
  /(?:(?:order|grand|invoice|purchase)\s+total|total\s+(?:charged|paid|billed)|amount\s+(?:charged|paid|billed|due)|\btotal\b)/gi;

const money = (n: number) => n.toFixed(2);

/**
 * Derive the label that precedes a known-correct total.
 *
 * Given the email text and the total the model reported, find that amount in
 * the text and take the words immediately before it. That phrase becomes the
 * deterministic rule for this vendor. Returns null when the amount cannot be
 * located or the surrounding wording is untrustworthy — better no template
 * than one that will confidently read the wrong number forever.
 */
export function learnTotalLabel(text: string, total: number): string | null {
  const target = money(total);
  // Match the amount with or without a thousands separator.
  const pattern = new RegExp(
    `\\$\\s?${target.replace(".", "\\.").replace(/^(\d)(\d{3})/, "$1,?$2")}(?!\\d)`,
    "g"
  );

  let bestLabel: string | null = null;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;

    // Bound the window at the previous amount so an earlier figure's wording
    // ("You saved a total of $11.80") cannot be mistaken for this one's label.
    const prior = [...text.slice(0, at).matchAll(/\$\s?[\d,]+\.\d{2}/g)].pop();
    const windowStart = prior ? (prior.index ?? 0) + prior[0].length : Math.max(0, at - 80);
    const before = text.slice(windowStart, at);
    if (BAD_LABEL.test(before)) continue;

    // Prefer an explicit total phrase; it is what the vendor calls the figure.
    const phrases = [...before.matchAll(TOTAL_PHRASE)];
    const phrase = phrases.length ? phrases[phrases.length - 1][0].trim() : null;
    if (phrase && !BAD_LABEL.test(phrase)) {
      bestLabel = phrase;
      continue;
    }

    // No total wording at all: fall back to the trailing words, which still
    // pins the layout for vendors who label the amount some other way.
    const words = before.replace(/[^A-Za-z\s:]/g, " ").split(/\s+/).filter(Boolean);
    const label = words.slice(-3).join(" ").trim();
    if (label.length >= 3 && label.length <= 40 && !BAD_LABEL.test(label)) {
      bestLabel = label;
    }
  }

  return bestLabel;
}

/**
 * Apply a learned label to a new email from the same vendor.
 * Returns null when the label is absent — the caller then falls back to the
 * model and marks the template as having missed.
 */
export function applyTotalLabel(text: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Letter boundaries, or a label of "TOTAL" matches inside "Subtotal" and
  // reads the pre-tax figure. \b is not enough when a label ends in punctuation.
  const re = new RegExp(
    `(?<![A-Za-z])${escaped}(?![A-Za-z])[^$\\d]{0,40}\\$\\s?([\\d,]+\\.\\d{2})`,
    "gi"
  );
  // Last match wins: receipts often restate the total near the end.
  const matches = [...text.matchAll(re)];
  if (!matches.length) return null;
  const value = Number(matches[matches.length - 1][1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** How many consecutive misses before we stop trusting a learned layout. */
export const TEMPLATE_MISS_LIMIT = 3;

export function shouldRelearn(t: { misses: number; status?: string }): boolean {
  return t.status === "failing" || t.misses >= TEMPLATE_MISS_LIMIT;
}

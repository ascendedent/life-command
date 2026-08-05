// Categorization pipeline v1 (spec §1.6, implemented in order):
//   1. user rules (priority-ordered, first match wins)
//   2. merchant map (one correction resolves that merchant forever)
//   3. Plaid PFC v2 baseline
//   4. Uncategorized -> review inbox
// Used by the sync worker on ingest and by the retroactive rule-apply API.
//
// Amount convention: Plaid's, stored as-is (positive = money out). Rule
// amount bounds match against the absolute value.

import { pfcToCategoryName } from "./pfc-map";

export interface RuleCriteria {
  merchant_contains?: string;
  merchant_regex?: string;
  amount_min?: number;
  amount_max?: number;
  account_id?: string;
}

export interface RuleActions {
  set_category_id?: string;
  rename_merchant?: string;
  add_tag_ids?: string[];
  hide?: boolean;
  needs_review?: boolean;
}

export interface TxnRule {
  id: string;
  priority: number;
  criteria: RuleCriteria;
  actions: RuleActions;
}

export interface MerchantMapEntry {
  clean_name: string | null;
  default_category_id: string | null;
}

export interface CategorizeInput {
  merchant: string | null;
  amount: number;
  account_id: string;
  pfc_primary: string | null;
  pfc_detailed: string | null;
}

export interface CategorizeContext {
  rules: TxnRule[]; // active, sorted by priority asc
  merchantMap: Map<string, MerchantMapEntry>; // keyed by merchantKey()
  categoryIdByName: Map<string, string>;
  uncategorizedId: string;
}

export interface CategorizeResult {
  category_id: string;
  category_source: "plaid" | "rule" | "merchant_map";
  merchant_clean: string | null;
  hidden: boolean;
  needs_review: boolean;
  tag_ids: string[];
  matched_rule_id: string | null;
}

/** Normalize a raw bank descriptor into a stable lookup key. */
export function merchantKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .replace(/[#*]\s*\d+/g, " ") // store numbers: "#3471"
    .replace(/\b\d{4,}\b/g, " ") // long digit runs (ids, phone fragments)
    .replace(/[^A-Z0-9& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/**
 * Normalise a *bank descriptor* into something that can be matched again next
 * month. Stricter than merchantKey, because descriptors carry per-transaction
 * noise that merchant names do not.
 *
 * "Online Transfer to CHK ...4321 transaction#: 10293847561 07/17" reduces to
 * "ONLINE TRANSFER TO CHK". merchantKey alone left "07 17" behind, so the
 * learned alias could never match a later transfer and the same question came
 * back every month.
 */
export function descriptorKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return (
    raw
      .toUpperCase()
      // dates in any common shape: 07/17, 07-17-26, 2026-08-05
      .replace(/\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
      // reference / transaction / confirmation numbers, separators optional
      .replace(
        /\b(?:TRANSACTION|TRANS|TXN|REF|REFERENCE|CONF|CONFIRMATION|AUTH|TRACE|SEQ|INV)\s*#?\s*:?\s*[A-Z0-9-]{4,}/g,
        " "
      )
      // masked account fragments: ...4321, XXXX4321, ****4321
      .replace(/[.*X]{2,}\s*\d{2,}/g, " ")
      .replace(/[#*]\s*:?\s*\d+/g, " ")
      .replace(/\b\d{4,}\b/g, " ")
      .replace(/[^A-Z0-9& ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40)
  );
}

/**
 * Banking boilerplate that identifies no one. Storing such a descriptor as a
 * vendor's signature would make every future transfer look like that vendor,
 * which is worse than having no pattern at all.
 */
const GENERIC_DESCRIPTOR_WORDS = new Set([
  "ONLINE", "TRANSFER", "XFER", "TO", "FROM", "CHK", "CHECKING", "SAV", "SAVINGS",
  "ACH", "PAYMENT", "PMT", "DEPOSIT", "WITHDRAWAL", "BILL", "PAY", "BILLPAY",
  "CHECK", "POS", "PURCHASE", "DEBIT", "CREDIT", "CARD", "ELECTRONIC", "WEB",
  "MOBILE", "BANK", "AUTOPAY", "RECURRING", "INTERNET", "EXTERNAL", "INTERNAL",
]);

/** True when a normalised descriptor is too generic to identify a vendor. */
export function isGenericDescriptor(key: string): boolean {
  const tokens = key.split(" ").filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((t) => GENERIC_DESCRIPTOR_WORDS.has(t));
}

/**
 * Wording that says money moved rather than money was spent.
 *
 * Shared because the same judgement is needed in more than one place and the
 * two copies would drift: receipt ingestion uses it to refuse a transfer
 * confirmation, and recurring detection uses it to refuse the descriptor of a
 * standing transfer that would otherwise be filed as a subscription. Matched
 * against whatever text identifies the thing — an email subject, a bank
 * descriptor, a merchant name.
 */
const MONEY_MOVEMENT_PATTERNS = [
  /\bonline transfer\b/i,
  /\btransfer (?:to|from)\b/i,
  /\bwire transfer\b/i,
  /\bach (?:credit|debit|transfer)\b/i,
  /\bdirect deposit\b/i,
  /\bzelle\b/i,
  /\bvenmo\b/i,
  /\bbill\s?pay\b/i,
  /\bp2p\b/i,
  /\btrf\b/i,
  /\bweb\s?id\b/i,
  /\btransaction\s?#/i,
  /\bconfirmation\s?#/i,
  /\b401\s?\(?k\)?\b/i,
  /\b(?:roth|ira|hsa|fsa)\b/i,
  /\bpayroll\b/i,
  /\bpay(?:check|stub)\b/i,
  /\bcontribution\b/i,
  /\bdeposit (?:posted|received|confirmation)\b/i,
  /\bwithdrawal\b/i,
  /\bbalance transfer\b/i,
  /\bautopay\b/i,
];

export function looksLikeMoneyMovement(text: string): boolean {
  return MONEY_MOVEMENT_PATTERNS.some((re) => re.test(text));
}

function titleCase(key: string): string {
  return key
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(And|Of|The)\b/g, (w) => w.toLowerCase());
}

export function ruleMatches(rule: TxnRule, txn: CategorizeInput): boolean {
  const c = rule.criteria ?? {};
  const merchant = (txn.merchant ?? "").toUpperCase();
  if (c.merchant_contains && !merchant.includes(c.merchant_contains.toUpperCase())) {
    return false;
  }
  if (c.merchant_regex) {
    try {
      if (!new RegExp(c.merchant_regex, "i").test(txn.merchant ?? "")) return false;
    } catch {
      return false; // invalid regex never matches
    }
  }
  const abs = Math.abs(txn.amount);
  if (c.amount_min != null && abs < c.amount_min) return false;
  if (c.amount_max != null && abs > c.amount_max) return false;
  if (c.account_id && c.account_id !== txn.account_id) return false;
  return true;
}

export function categorizeTransaction(
  txn: CategorizeInput,
  ctx: CategorizeContext
): CategorizeResult {
  const result: CategorizeResult = {
    category_id: ctx.uncategorizedId,
    category_source: "plaid",
    merchant_clean: null,
    hidden: false,
    needs_review: false,
    tag_ids: [],
    matched_rule_id: null,
  };

  // 1. rules — first match wins; non-category actions apply even when the
  //    rule sets no category (category then falls through the pipeline)
  let ruleSetCategory = false;
  for (const rule of ctx.rules) {
    if (!ruleMatches(rule, txn)) continue;
    const a = rule.actions ?? {};
    result.matched_rule_id = rule.id;
    if (a.rename_merchant) result.merchant_clean = a.rename_merchant;
    if (a.add_tag_ids?.length) result.tag_ids = a.add_tag_ids;
    if (a.hide) result.hidden = true;
    if (a.needs_review) result.needs_review = true;
    if (a.set_category_id) {
      result.category_id = a.set_category_id;
      result.category_source = "rule";
      ruleSetCategory = true;
    }
    break;
  }

  // 2. merchant map
  const key = merchantKey(txn.merchant);
  const mapped = key ? ctx.merchantMap.get(key) : undefined;
  if (mapped) {
    if (!result.merchant_clean && mapped.clean_name) {
      result.merchant_clean = mapped.clean_name;
    }
    if (!ruleSetCategory && mapped.default_category_id) {
      result.category_id = mapped.default_category_id;
      result.category_source = "merchant_map";
      return finalize(result, key);
    }
  }
  if (ruleSetCategory) return finalize(result, key);

  // 3. PFC baseline
  const pfcName = pfcToCategoryName(txn.pfc_primary, txn.pfc_detailed);
  const pfcId = pfcName ? ctx.categoryIdByName.get(pfcName) : undefined;
  if (pfcId) {
    result.category_id = pfcId;
    result.category_source = "plaid";
    return finalize(result, key);
  }

  // 4. Uncategorized -> review inbox
  result.category_id = ctx.uncategorizedId;
  result.category_source = "plaid";
  result.needs_review = true;
  return finalize(result, key);
}

function finalize(result: CategorizeResult, key: string): CategorizeResult {
  if (!result.merchant_clean && key) result.merchant_clean = titleCase(key);
  return result;
}


/**
 * Merchants whose baskets genuinely vary transaction to transaction.
 *
 * A category learned from one of these must never be written back to
 * merchant_map. It is the single most destructive thing the app can do to its
 * own data: correcting one Amazon refund to "Refunds & Reimbursements" taught
 * the map, and 537 Amazon *purchases* were then filed as refunds — $12,900 of
 * spending recorded as money coming in. The same slip through Walmart filed 22
 * grocery runs as "Credit Card Payment", which lives in the transfer group and
 * is excluded from budgets and cash flow entirely, so that spending vanished.
 *
 * Shared deliberately: the enrichment pass has always had this guard, and the
 * inline correction in the transactions list did not. One list, both callers.
 */
export const MIXED_BASKET_MERCHANTS = [
  "amazon", "amzn", "costco", "target", "walmart", "sams club", "bj's", "bjs wholesale",
  "kroger", "meijer", "cvs", "walgreens", "ebay", "etsy", "aliexpress", "temu",
];

/** True when a category learned from this merchant must not be generalised. */
export function isMixedBasket(merchant: string | null | undefined): boolean {
  if (!merchant) return false;
  const m = merchant.toLowerCase();
  return MIXED_BASKET_MERCHANTS.some((x) => m.includes(x));
}

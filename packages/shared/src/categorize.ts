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

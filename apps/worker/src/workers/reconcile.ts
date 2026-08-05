import type { SupabaseClient } from "@supabase/supabase-js";
import {
  audit,
  merchantKey,
  descriptorKey,
  isGenericDescriptor,
  applyReceiptItems,
} from "@finance/shared";
import { checkWatchlist } from "./gmail.js";


// Reconciliation as a scored linkage layer (spec §1.7.4): when a bank
// transaction posts, score it against open anticipations on amount, semantic
// vendor match, date proximity, and card last-four. High confidence
// auto-reconciles silently; medium stores the candidate for a one-tap
// clarification in the UI; low is ignored. Every resolution feeds
// vendor_signatures (§1.7.5).

interface NewTxn {
  id: string;
  merchant: string | null;
  amount: number;
  date: string;
  account_id: string;
}

interface OpenAnticipation {
  id: string;
  vendor: string;
  amount: number;
  card_last4: string | null;
  account_id: string | null;
  category_id: string | null;
  is_business: boolean;
  business_entity: string | null;
  expected_descriptor_patterns: string[];
  email_receipt_id: string | null;
}

function scoreMatch(txn: NewTxn, ant: OpenAnticipation, accountMask: string | null) {
  const factors: Record<string, number> = {};
  const txnAmt = Math.abs(txn.amount);
  const antAmt = Number(ant.amount);

  if (Math.abs(txnAmt - antAmt) < 0.005) factors.amount_exact = 0.5;
  else if (Math.abs(txnAmt - antAmt) / antAmt < 0.02) factors.amount_close = 0.35;
  else if (txnAmt > antAmt * 1.1 && txnAmt < antAmt * 1.25) factors.amount_tip_range = 0.2;
  else return { score: 0, factors };

  const txnKey = merchantKey(txn.merchant);
  const antKey = merchantKey(ant.vendor);
  const patternHit = ant.expected_descriptor_patterns.some(
    (p) => txnKey.includes(merchantKey(p)) || merchantKey(p).includes(txnKey)
  );
  if (patternHit) factors.descriptor_pattern = 0.3;
  else if (txnKey && antKey && (txnKey.includes(antKey) || antKey.includes(txnKey))) {
    factors.name_contains = 0.25;
  } else {
    // token overlap fallback
    const txnTokens = new Set(txnKey.split(" "));
    const overlap = antKey.split(" ").filter((t) => t.length > 2 && txnTokens.has(t));
    if (overlap.length > 0) factors.name_token_overlap = 0.15;
  }

  if (ant.card_last4 && accountMask && ant.card_last4 === accountMask) {
    factors.card_last4 = 0.2;
  }
  factors.date_proximity = 0.1; // anticipations are ≤14d old by construction

  const score = Object.values(factors).reduce((a, b) => a + b, 0);
  return { score: Math.min(1, score), factors };
}

async function learnSignature(
  db: SupabaseClient,
  vendor: string,
  descriptor: string | null,
  exact: boolean
) {
  // Only learn a descriptor that can match a future charge: per-transaction
  // reference numbers and dates are stripped, and what is left is discarded
  // if it is pure banking boilerplate ("ONLINE TRANSFER TO CHK") that would
  // otherwise claim every transfer as this vendor.
  const normalized = descriptorKey(descriptor);
  const pattern = isGenericDescriptor(normalized) ? "" : normalized;
  const { data: existing } = await db
    .from("vendor_signatures")
    .select("id, descriptor_patterns, exact_match_count, mismatch_count")
    .ilike("vendor_name", vendor)
    .maybeSingle();
  if (existing) {
    const patterns = new Set(existing.descriptor_patterns ?? []);
    if (pattern) patterns.add(pattern);
    await db
      .from("vendor_signatures")
      .update({
        descriptor_patterns: [...patterns],
        exact_match_count: existing.exact_match_count + (exact ? 1 : 0),
        mismatch_count: existing.mismatch_count + (exact ? 0 : 1),
        reliability:
          (existing.exact_match_count + (exact ? 1 : 0)) /
          (existing.exact_match_count + existing.mismatch_count + 1),
      })
      .eq("id", existing.id);
  } else {
    await db.from("vendor_signatures").insert({
      vendor_name: vendor,
      descriptor_patterns: pattern ? [pattern] : [],
      exact_match_count: exact ? 1 : 0,
      mismatch_count: exact ? 0 : 1,
      reliability: exact ? 1 : 0,
      source: "auto",
    });
  }
}

/** Called by the sync worker for each newly-inserted bank transaction. */
export async function reconcileNewTransaction(
  db: SupabaseClient,
  txn: NewTxn,
  accountMask: string | null
): Promise<void> {
  if (txn.amount <= 0) return; // inflows don't reconcile against receipts

  await checkWatchlist(db, txn.merchant ?? "", "plaid_sync", {
    txnId: txn.id,
    amount: Math.abs(txn.amount),
  });

  const { data: open } = await db
    .from("anticipated_transactions")
    .select(
      "id, vendor, amount, card_last4, account_id, category_id, is_business, business_entity, expected_descriptor_patterns, email_receipt_id"
    )
    .eq("status", "open");
  if (!open?.length) return;

  let best: { ant: OpenAnticipation; score: number; factors: Record<string, number> } | null = null;
  for (const ant of open as OpenAnticipation[]) {
    const { score, factors } = scoreMatch(txn, ant, accountMask);
    if (!best || score > best.score) best = { ant, score, factors };
  }
  if (!best || best.score < 0.4) return;

  if (best.score >= 0.75) {
    // high confidence: auto-reconcile silently (spec §1.7.4)
    const updates: Record<string, unknown> = { receipt_status: "uploaded" };
    if (best.ant.category_id) {
      updates.category_id = best.ant.category_id;
      updates.category_source = "merchant_map";
    }
    if (best.ant.is_business) {
      updates.is_business = true;
      updates.business_source = "account_default";
      updates.business_entity = best.ant.business_entity;
    }
    await db.from("transactions").update(updates).eq("id", txn.id);
    await db.from("receipts").insert({
      transaction_id: txn.id,
      file_ref: `email:${best.ant.email_receipt_id ?? best.ant.id}`,
      source: "gmail",
    });
    await db
      .from("anticipated_transactions")
      .update({
        status: "reconciled",
        reconciled_transaction_id: txn.id,
        reconciled_at: new Date().toISOString(),
        reconciliation_confidence: best.score,
        reconciliation_factors: best.factors,
      })
      .eq("id", best.ant.id);
    if (best.ant.email_receipt_id) {
      await db
        .from("email_receipts")
        .update({
          match_status: "auto_matched",
          matched_transaction_id: txn.id,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", best.ant.email_receipt_id);
      // Item-level categories, once there is a real transaction to attach them
      // to. Runs after the category above so the receipt's own basket wins.
      await applyReceiptItems(db, best.ant.email_receipt_id, txn.id).catch((e: Error) =>
        console.error("[reconcile] item split failed:", e.message)
      );
    }
    await learnSignature(db, best.ant.vendor, txn.merchant, best.factors.amount_exact != null);
    await audit(db, "system", "anticipation_reconciled", "anticipated_transactions", best.ant.id, {
      score: best.score,
      txn: txn.id,
    });
  } else {
    // medium: store candidate for the one-tap "Is X the same as Y?" prompt
    await db
      .from("anticipated_transactions")
      .update({
        reconciliation_confidence: best.score,
        reconciliation_factors: { ...best.factors, candidate_transaction_id: txn.id },
      })
      .eq("id", best.ant.id);
  }
}

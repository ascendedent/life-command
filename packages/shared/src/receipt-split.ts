import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "./db";
import {
  planSplit,
  unanimousCategory,
  type ReceiptItem,
  type ReceiptTotals,
  type StoredItemLines,
} from "./receipt-items";

/**
 * Turn a parsed receipt's line items into a categorised transaction.
 *
 * One Walmart charge is groceries, a toy and cough drops; filed whole it makes
 * the grocery budget wrong by the price of the toy, every time. Three outcomes,
 * in descending order of how sure we are:
 *
 *   split       — the items are complete and priced and span categories, so the
 *                 charge is broken into one child per category
 *   categorized — the items are complete and all one kind, so there is nothing
 *                 to split but plenty to correct
 *   suggested   — the items span categories but don't add up (a Walmart
 *                 delivery mail names 6 of 23 items and prices none of them),
 *                 so the plan is stored for the owner and nothing is written
 *
 * The suggestion path is the common one on real retail mail, and that is the
 * point: a split written from a partial itemisation is wrong in a way nobody
 * would ever notice.
 */

export type ReceiptSplitOutcome = "split" | "categorized" | "suggested" | "none";

interface ParsedReceipt {
  line_items?: ReceiptItem[] | null;
  total?: number | null;
  subtotal?: number | null;
  tax?: number | null;
  item_count?: number | null;
}

/** The parse result lives under `line_items.llm` on the receipt row. */
export function parsedFrom(lineItems: unknown): ParsedReceipt | null {
  if (!lineItems || typeof lineItems !== "object") return null;
  const llm = (lineItems as { llm?: unknown }).llm;
  if (!llm || typeof llm !== "object") return null;
  return llm as ParsedReceipt;
}

async function categoryIdsByName(
  db: SupabaseClient,
  names: string[]
): Promise<Map<string, string>> {
  if (!names.length) return new Map();
  const { data } = await db.from("categories").select("id, name").in("name", names);
  return new Map((data ?? []).map((c: { id: string; name: string }) => [c.name, c.id]));
}

export async function applyReceiptItems(
  db: SupabaseClient,
  receiptId: string,
  txnId: string
): Promise<ReceiptSplitOutcome> {
  const { data: receipt } = await db
    .from("email_receipts")
    .select("id, vendor, line_items")
    .eq("id", receiptId)
    .maybeSingle();
  if (!receipt) return "none";

  const parsed = parsedFrom(receipt.line_items);
  const items = (parsed?.line_items ?? []).filter(
    (i): i is ReceiptItem => !!i && typeof i.description === "string"
  );
  if (!items.length) return "none";

  const { data: txn } = await db
    .from("transactions")
    .select(
      "id, account_id, date, amount, merchant, merchant_clean, category_id, category_source, is_business, business_entity, hidden, parent_transaction_id"
    )
    .eq("id", txnId)
    .maybeSingle();
  if (!txn) return "none";

  // A hidden parent has already been split, and a child is not itself
  // splittable. Either way the dollars are already accounted for once.
  if (txn.hidden || txn.parent_transaction_id) return "none";
  const { count: childCount } = await db
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("parent_transaction_id", txnId);
  if (childCount) return "none";

  const totals: ReceiptTotals = {
    total: parsed?.total ?? null,
    subtotal: parsed?.subtotal ?? null,
    tax: parsed?.tax ?? null,
    itemCount: parsed?.item_count ?? null,
  };
  const charge = Math.abs(Number(txn.amount));
  const plan = planSplit(items, totals, charge);

  // The parse is kept on the transaction whatever we decide with it: it is the
  // record of why a split happened, and what the UI offers when one didn't.
  const record: StoredItemLines = {
    source: "email_receipt",
    email_receipt_id: receiptId,
    items,
    coverage: plan.coverage,
    plan: { parts: plan.parts, overhead: plan.overhead, reason: plan.reason },
  };

  // An owner who categorised this themselves has said what it is. Propose,
  // never overrule.
  const ownerSet = txn.category_source === "user";

  if (plan.autoApplicable && !ownerSet) {
    const ids = await categoryIdsByName(db, plan.parts.map((p) => p.categoryName));
    const missing = plan.parts.filter((p) => !ids.has(p.categoryName));
    if (!missing.length) {
      const rows = plan.parts.map((p) => ({
        parent_transaction_id: txn.id,
        account_id: txn.account_id,
        date: txn.date,
        amount: p.amount,
        merchant: txn.merchant,
        merchant_clean: txn.merchant_clean,
        description: p.items.slice(0, 4).join(", ") + (p.items.length > 4 ? ", …" : ""),
        category_id: ids.get(p.categoryName),
        category_source: "llm",
        is_business: txn.is_business,
        business_source: txn.is_business ? "account_default" : null,
        business_entity: txn.business_entity,
      }));
      const { error } = await db.from("transactions").insert(rows);
      if (!error) {
        await db
          .from("transactions")
          .update({ hidden: true, needs_review: false, item_lines: record })
          .eq("id", txn.id);
        await audit(db, "system", "transaction_split_from_receipt", "transactions", txn.id, {
          receipt: receiptId,
          vendor: receipt.vendor,
          parts: plan.parts.map((p) => ({ category: p.categoryName, amount: p.amount })),
        });
        console.log(
          `[receipt-split] ${receipt.vendor}: $${charge.toFixed(2)} → ${plan.parts
            .map((p) => `${p.categoryName} $${p.amount.toFixed(2)}`)
            .join(", ")}`
        );
        return "split";
      }
      console.error("[receipt-split] insert failed:", error.message);
    }
  }

  // Nothing to split, but the basket says what this charge was. This is the
  // whole-order-is-groceries case, and it holds even when nothing was priced.
  const unanimous = unanimousCategory(items, totals);
  if (unanimous && !ownerSet) {
    const ids = await categoryIdsByName(db, [unanimous.categoryName]);
    const id = ids.get(unanimous.categoryName);
    if (id && id !== txn.category_id) {
      await db
        .from("transactions")
        .update({
          category_id: id,
          category_source: "llm",
          needs_review: false,
          item_lines: record,
        })
        .eq("id", txn.id);
      await audit(db, "system", "transaction_categorized_from_items", "transactions", txn.id, {
        receipt: receiptId,
        category: unanimous.categoryName,
        items: items.length,
      });
      return "categorized";
    }
  }

  // Mixed basket we can't price: hand it to the owner with the plan attached
  // rather than guessing, and flag it so it surfaces in the review inbox.
  // Keyed on the categories seen rather than on the priced parts — a Walmart
  // order that names a toy, cough drops and bananas without pricing any of them
  // produces no parts at all, and that is precisely the charge worth a second
  // look: it is certainly not all groceries, whatever it is currently filed as.
  if (plan.coverage.categories.length >= 2) {
    await db
      .from("transactions")
      .update({ item_lines: record, needs_review: true })
      .eq("id", txn.id);
    return "suggested";
  }

  await db.from("transactions").update({ item_lines: record }).eq("id", txn.id);
  return "none";
}

// Queries the chat can run against the whole book.
//
// The alternative was stuffing history into the prompt. At 3,000+ transactions
// that is ~75k tokens on every single turn, most of it irrelevant to whatever
// was asked, and it still cannot answer "what did I spend at that garden centre
// in March" because the summary that fits has already thrown the detail away.
//
// So the model gets to ask instead. Same discipline as everywhere else: account
// identifiers masked to a last-four, `hidden = false` alone so a split is
// counted once via its children, and transfers separated from spending rather
// than silently mixed in.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "./db";

export interface TransactionSearch {
  from?: string;
  to?: string;
  merchant?: string;
  category?: string;
  account?: string;
  min_amount?: number;
  max_amount?: number;
  /** Outflows, inflows, or both. Amounts are positive for money leaving. */
  direction?: "out" | "in" | "any";
  include_transfers?: boolean;
  limit?: number;
}

interface Row {
  id: string;
  date: string;
  amount: number;
  merchant_clean: string | null;
  merchant: string | null;
  categories: { name: string; category_groups?: { type: string } | null } | null;
  accounts: { name: string; mask: string | null } | null;
}

const label = (a: Row["accounts"]) => `${a?.name ?? "unknown"} ‥${a?.mask ?? "????"}`;

/** Hard ceiling regardless of what is asked for — a tool result is context too. */
const MAX_ROWS = 300;

export async function searchTransactions(db: SupabaseClient, p: TransactionSearch) {
  const limit = Math.min(p.limit ?? 50, MAX_ROWS);

  // Every filter runs in SQL, and that is the whole point.
  //
  // The first version applied `limit` in the database and then filtered by
  // account and category in JavaScript. Asking for one card returned the most
  // recent N transactions across *all* accounts and kept whichever happened to
  // be on that card — usually none. It reported "0 matched" for a card with a
  // four-figure statement balance, and reported it confidently. A wrong answer
  // delivered calmly is worse than an error, and this is a tool the model
  // reasons from.
  const transferIds = p.include_transfers ? [] : await transferCategoryIds(db);

  // `!inner` turns the join into a real inner join so a filter on the joined
  // table narrows rows instead of blanking the relation.
  const accountJoin = p.account ? "accounts!inner (name, mask)" : "accounts (name, mask)";
  const categoryJoin = p.category
    ? "categories!inner (name, category_groups (type))"
    : "categories (name, category_groups (type))";

  let q = db
    .from("transactions")
    .select(`id, date, amount, merchant_clean, merchant, ${categoryJoin}, ${accountJoin}`)
    // A split hides its parent and creates children; this counts each dollar
    // exactly once. Adding a parent filter would drop every split.
    .eq("hidden", false);

  if (p.from) q = q.gte("date", p.from);
  if (p.to) q = q.lte("date", p.to);
  // Both spellings, because a merchant the pipeline has not cleaned yet only
  // exists under the raw descriptor.
  if (p.merchant) q = q.or(`merchant_clean.ilike.%${p.merchant}%,merchant.ilike.%${p.merchant}%`);
  if (p.direction === "out") q = q.gt("amount", 0);
  if (p.direction === "in") q = q.lt("amount", 0);
  if (p.min_amount != null) q = q.gte("amount", p.min_amount);
  if (p.max_amount != null) q = q.lte("amount", p.max_amount);
  if (p.category) q = q.ilike("categories.name", `%${p.category}%`);
  if (p.account) {
    const want = p.account.trim();
    // A bare last-four is exact. Matching it against the label as well would
    // also hit any card whose *name* contains those digits, and several cards
    // here share a name and differ only by mask.
    q = /^\d{4}$/.test(want)
      ? q.eq("accounts.mask", want)
      : q.ilike("accounts.name", `%${want}%`);
  }
  if (transferIds.length) {
    q = q.or(`category_id.is.null,category_id.not.in.(${transferIds.join(",")})`);
  }

  const { data, error, count } = await q
    .order("date", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as Row[];
  return {
    returned: rows.length,
    truncated: rows.length === limit,
    // Stated so the model can say "no transfers were counted" rather than
    // leaving the owner to wonder why a card payment is missing.
    transfers_included: !!p.include_transfers,
    transactions: rows.map((r) => ({
      // Needed to act on a row later; categorising takes ids, never a filter,
      // so what gets changed is exactly what was looked at.
      id: r.id,
      date: r.date,
      merchant: r.merchant_clean ?? r.merchant,
      amount: Number(r.amount),
      category: r.categories?.name ?? "Uncategorized",
      account: label(r.accounts),
    })),
    ...(count != null ? { total_matching: count } : {}),
  };
}

/** Categories in the transfer group — the same dollar counted twice. */
async function transferCategoryIds(db: SupabaseClient): Promise<string[]> {
  const { data } = await db
    .from("categories")
    .select("id, category_groups!inner (type)")
    .eq("category_groups.type", "transfer");
  return (data ?? []).map((c) => c.id as string);
}

export interface SpendingSummary {
  from?: string;
  to?: string;
  group_by: "category" | "merchant" | "month" | "account";
  direction?: "out" | "in";
  include_transfers?: boolean;
  limit?: number;
}

export async function spendingSummary(db: SupabaseClient, p: SpendingSummary) {
  // `any` because PostgREST infers joined relations as arrays while a
  // to-one join returns an object; the shape is asserted below instead.
   
  const rows = (await fetchAll<any>(() => {
    let q = db
      .from("transactions")
      .select("id, date, amount, merchant_clean, merchant, categories (name, category_groups (type)), accounts (name, mask)")
      .eq("hidden", false);
    if (p.from) q = q.gte("date", p.from);
    if (p.to) q = q.lte("date", p.to);
    if (p.direction !== "in") q = q.gt("amount", 0);
    else q = q.lt("amount", 0);
    return q.order("date").order("id");
  })) as unknown as Row[];

  const usable = p.include_transfers
    ? rows
    : rows.filter((r) => r.categories?.category_groups?.type !== "transfer");

  const keyOf = (r: Row) =>
    p.group_by === "category"
      ? r.categories?.name ?? "Uncategorized"
      : p.group_by === "merchant"
        ? r.merchant_clean ?? r.merchant ?? "Unknown"
        : p.group_by === "account"
          ? label(r.accounts)
          : String(r.date).slice(0, 7);

  const totals = new Map<string, { total: number; count: number }>();
  for (const r of usable) {
    const k = keyOf(r);
    const e = totals.get(k) ?? { total: 0, count: 0 };
    e.total += Math.abs(Number(r.amount));
    e.count++;
    totals.set(k, e);
  }

  const entries = [...totals.entries()]
    .map(([key, v]) => ({ key, total: Math.round(v.total * 100) / 100, count: v.count }))
    // Months read best in order; everything else reads best largest-first.
    .sort((a, b) => (p.group_by === "month" ? a.key.localeCompare(b.key) : b.total - a.total))
    .slice(0, Math.min(p.limit ?? 40, 200));

  return {
    grouped_by: p.group_by,
    transfers_included: !!p.include_transfers,
    transactions_counted: usable.length,
    grand_total: Math.round(usable.reduce((s, r) => s + Math.abs(Number(r.amount)), 0) * 100) / 100,
    groups: entries,
  };
}

/** The span the book actually covers, so the model never guesses at it. */
export async function historyRange(db: SupabaseClient) {
  const [{ data: oldest }, { data: newest }, { count }] = await Promise.all([
    db.from("transactions").select("date").eq("hidden", false).order("date").limit(1),
    db.from("transactions").select("date").eq("hidden", false).order("date", { ascending: false }).limit(1),
    db.from("transactions").select("id", { count: "exact", head: true }).eq("hidden", false),
  ]);
  return {
    earliest: oldest?.[0]?.date ?? null,
    latest: newest?.[0]?.date ?? null,
    transactions: count ?? 0,
  };
}


/**
 * Every account, and how to name one in a query.
 *
 * Without this the model has to guess at an identifier. Several cards here read
 * the same and differ only by their last four, so `account` is quoted back with
 * the mask attached and the mask is given separately as the exact key — asking
 * for "6655" means that card and no other.
 */
export async function listAccounts(db: SupabaseClient) {
  const [{ data: accounts }, { data: liabilities }] = await Promise.all([
    db
      .from("accounts")
      .select("id, name, mask, type, subtype, current_balance, household_members (name)"),
    db
      .from("liabilities")
      .select("account_id, apr, aprs, last_statement_balance, minimum_payment, next_due_date, is_overdue"),
  ]);

  const rates = new Map(
    (liabilities ?? []).map((l) => {
      const entries = (Array.isArray(l.aprs) ? l.aprs : []) as {
        apr_type?: string;
        apr_percentage?: number | null;
      }[];
      const named = entries.filter((e) => typeof e.apr_percentage === "number");
      const promo = named.find((e) => e.apr_type === "special");
      const purchase = named.find((e) => e.apr_type === "purchase_apr");
      return [
        l.account_id as string,
        {
          rate_being_paid_pct:
            promo?.apr_percentage ?? purchase?.apr_percentage ?? (l.apr != null ? Number(l.apr) : null),
          on_promotional_rate: !!promo,
          last_statement_balance: l.last_statement_balance,
          minimum_payment: l.minimum_payment,
          next_due_date: l.next_due_date,
          is_overdue: l.is_overdue,
        },
      ];
    })
  );

  return {
    accounts: (accounts ?? []).map((a) => {
      const r = rates.get(a.id as string);
      return {
        // Quote this back to the owner; pass `mask` to search_transactions.
        account: `${a.name} ‥${a.mask ?? "????"}`,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        current_balance: a.current_balance,
        belongs_to: (a.household_members as unknown as { name?: string } | null)?.name ?? null,
        ...(r ?? {}),
        // Said outright, because a blank rate otherwise reads as 0%.
        ...(a.type === "credit" && !r?.rate_being_paid_pct
          ? { rate_note: "this institution does not report a rate to Plaid" }
          : {}),
      };
    }),
  };
}


// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Categories that may be assigned, so a name is never invented. */
export async function listCategories(db: SupabaseClient) {
  const { data } = await db
    .from("categories")
    .select("id, name, category_groups (name, type)")
    .eq("is_active", true)
    .order("name");
  return {
    categories: (data ?? []).map((c) => ({
      name: c.name as string,
      group: (c.category_groups as unknown as { name?: string } | null)?.name ?? null,
      type: (c.category_groups as unknown as { type?: string } | null)?.type ?? null,
    })),
  };
}

export interface CategorizeRequest {
  transaction_ids: string[];
  category: string;
  /** Teach the merchant map so future charges from it land here too. */
  apply_to_future?: boolean;
}

/** No single instruction may restate more of the book than this. */
const MAX_RECATEGORIZE = 200;

/**
 * Recategorise specific transactions.
 *
 * Takes ids, never a filter. A filter would let one instruction reach rows
 * nobody looked at, and the difference between "these six" and "everything
 * matching this word" is the difference between a correction and an incident.
 *
 * `apply_to_future` teaches the merchant map, and that is the part with a
 * history. One Amazon refund filed by hand once taught the map "Amazon =
 * Refunds", after which 537 Amazon purchases were recorded as money arriving.
 * The same guard the UI carries applies here: merchants that sell across
 * unrelated categories are never generalised, however explicitly asked.
 *
 * Every change records what the category was before it, so a wrong call can be
 * undone from the audit log rather than reconstructed from memory.
 */
export async function categorizeTransactions(db: SupabaseClient, p: CategorizeRequest) {
  const { isMixedBasket, merchantKey } = await import("./categorize");

  const ids = [...new Set(p.transaction_ids ?? [])].filter(Boolean);
  if (!ids.length) return { changed: 0, error: "no transaction ids given" };
  if (ids.length > MAX_RECATEGORIZE) {
    return {
      changed: 0,
      error: `${ids.length} transactions asked for; ${MAX_RECATEGORIZE} is the most one instruction may change. Narrow it, or do it in batches the owner can see.`,
    };
  }

  // The category must already exist. Inventing one is how a book grows three
  // spellings of the same thing.
  const { data: cats } = await db
    .from("categories")
    .select("id, name")
    .ilike("name", p.category)
    .eq("is_active", true)
    .limit(2);
  if (!cats?.length) {
    return { changed: 0, error: `no active category named "${p.category}" — call list_categories first` };
  }
  if (cats.length > 1) {
    return { changed: 0, error: `"${p.category}" matches more than one category; name it exactly` };
  }
  const categoryId = cats[0].id as string;
  const categoryName = cats[0].name as string;

  // Read before writing, so the audit entry can say what it replaced.
  const { data: before } = await db
    .from("transactions")
    .select("id, category_id, merchant, merchant_clean, categories (name)")
    .in("id", ids);
  if (!before?.length) return { changed: 0, error: "none of those transactions exist" };

  const { error } = await db
    .from("transactions")
    .update({
      category_id: categoryId,
      // Marked as the owner's decision, which stops the nightly enrichment
      // pass from overwriting it.
      category_source: "user",
      needs_review: false,
      reviewed_at: new Date().toISOString(),
    })
    .in("id", ids);
  if (error) return { changed: 0, error: error.message };

  // Teaching the map, if asked and if the merchant can bear it.
  const taught: string[] = [];
  const refused: string[] = [];
  if (p.apply_to_future) {
    const merchants = new Map<string, string | null>();
    for (const t of before) {
      const name = (t.merchant_clean ?? t.merchant) as string | null;
      if (name) merchants.set(name, (t.merchant_clean as string) ?? null);
    }
    for (const [name, clean] of merchants) {
      if (isMixedBasket(name)) {
        refused.push(name);
        continue;
      }
      const key = merchantKey(name);
      if (!key) continue;
      await db.from("merchant_map").upsert(
        {
          raw_pattern: key,
          clean_name: clean,
          default_category_id: categoryId,
          source: "user",
          confidence: 1,
        },
        { onConflict: "raw_pattern" }
      );
      taught.push(name);
    }
  }

  await db.from("audit_log").insert({
    actor: "user",
    action: "transactions_recategorized_via_chat",
    entity: "transactions",
    detail: {
      category: categoryName,
      count: before.length,
      taught_merchant_map: taught,
      refused_mixed_basket: refused,
      // Enough to reverse it by hand.
      previous: before.map((t) => ({
        id: t.id,
        was: (t.categories as unknown as { name?: string } | null)?.name ?? null,
        category_id: t.category_id,
      })),
    },
  });

  return {
    changed: before.length,
    category: categoryName,
    ...(taught.length ? { future_charges_will_also_use_this: taught } : {}),
    ...(refused.length
      ? {
          not_generalised: refused,
          why: "these merchants sell across unrelated categories, so one correction must not restate the rest",
        }
      : {}),
    reversible: "the previous categories are recorded in the audit log",
  };
}

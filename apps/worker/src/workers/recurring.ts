import type { SupabaseClient } from "@supabase/supabase-js";
import { audit, fetchAll, looksLikeMoneyMovement } from "@finance/shared";

// Recurring detection v1 (spec Phase 1): score merchant + cadence + amount
// regularity over the trailing 400 days; flag price changes and missed
// charges. The subscription-review machinery on top arrives in Phase 2.

interface TxnLite {
  merchant: string | null;
  merchant_clean: string | null;
  amount: number;
  date: string;
  account_id: string;
  category_id: string | null;
  parent_transaction_id: string | null;
  id: string;
}

/**
 * Money moving between the owner's own accounts is not a bill.
 *
 * A standing $200 transfer to savings and a $5/week P2P payment are both
 * perfectly regular in amount and cadence, which is exactly what this detector
 * looks for — the first real run filed both, and marked the P2P one a
 * *subscription*, which would have put "Acme Bank P2p Trf Pat Doe Ma Web
 * I" in front of the monthly recap's subscription review asking whether to
 * cancel it. Excluded two ways: by category group, which is authoritative once
 * a transfer is categorised, and by descriptor, which catches the ones that
 * haven't been.
 */
async function transferCategoryIds(db: SupabaseClient): Promise<Set<string>> {
  const { data } = await db
    .from("categories")
    .select("id, category_groups!inner(name)")
    .in("category_groups.name", ["Transfers", "Income"]);
  return new Set((data ?? []).map((c: { id: string }) => c.id));
}

/**
 * A recurring bill you cannot cancel is not a subscription.
 *
 * `is_subscription` feeds the monthly recap's subscription review, which issues
 * keep / replace / cut verdicts. Rent qualified on the detector's original test
 * — perfectly regular cadence, identical amount every month — which is exactly
 * backwards: the more unavoidable the obligation, the better it scored. The
 * review is for things there is a decision to make about.
 */
const NEVER_A_SUBSCRIPTION = new Set([
  "Rent",
  "Mortgage",
  "Property Tax",
  "Loan Payment",
  "Auto Payment",
  "Auto Insurance",
  "Insurance",
  "Taxes",
  "Childcare",
]);

async function nonSubscriptionCategoryIds(db: SupabaseClient): Promise<Set<string>> {
  const { data } = await db
    .from("categories")
    .select("id, name")
    .in("name", [...NEVER_A_SUBSCRIPTION]);
  return new Set((data ?? []).map((c: { id: string }) => c.id));
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function cadenceFromGap(days: number): { cadence: string; ok: boolean } {
  if (days >= 6 && days <= 8) return { cadence: "weekly", ok: true };
  if (days >= 12 && days <= 16) return { cadence: "custom", ok: true }; // biweekly
  if (days >= 26 && days <= 35) return { cadence: "monthly", ok: true };
  if (days >= 80 && days <= 100) return { cadence: "custom", ok: true }; // quarterly
  if (days >= 340 && days <= 390) return { cadence: "annual", ok: true };
  return { cadence: "custom", ok: false };
}

export async function detectRecurring(db: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
  const excluded = await transferCategoryIds(db);
  const notSubscribable = await nonSubscriptionCategoryIds(db);
  // Paged, and ordered with `id` as a tiebreaker so the pages line up. Read
  // unpaged this returned the oldest 1,000 of 1,459 matching rows and the
  // detector concluded every bill had stopped in May.
  const txns = await fetchAll<TxnLite>(() =>
    db
      .from("transactions")
      .select("id, merchant, merchant_clean, amount, date, account_id, category_id, parent_transaction_id")
      .gte("date", cutoff)
      .gt("amount", 0) // outflows only
      .eq("hidden", false)
      .order("date")
      .order("id")
  );
  if (!txns.length) return;

  // A split charge reaches here as its children, because the parent is hidden.
  // Recurring detection wants the whole charge — a $90 grocery run split into
  // $60 and $30 is one recurring charge, not two irregular ones — so children
  // of the same parent are recombined before anything is measured.
  const bySplit = new Map<string, TxnLite>();
  const rows: TxnLite[] = [];
  for (const t of txns) {
    if (!t.parent_transaction_id) {
      rows.push(t);
      continue;
    }
    const merged = bySplit.get(t.parent_transaction_id);
    if (merged) merged.amount = Number(merged.amount) + Number(t.amount);
    else {
      const copy = { ...t, amount: Number(t.amount) };
      bySplit.set(t.parent_transaction_id, copy);
      rows.push(copy);
    }
  }

  const groups = new Map<string, TxnLite[]>();
  for (const t of rows) {
    const name = t.merchant_clean ?? t.merchant;
    if (!name) continue;
    if (t.category_id && excluded.has(t.category_id)) continue;
    if (looksLikeMoneyMovement(name)) continue;
    const key = `${name}::${t.account_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  let found = 0;
  const touched = new Set<string>();
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    const dates = list.map((t) => new Date(t.date).getTime());
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i] - dates[i - 1]) / 86400_000);
    }
    const medGap = median(gaps);
    const { cadence, ok } = cadenceFromGap(medGap);
    if (!ok) continue;
    // gap regularity: most gaps near the median
    const regular = gaps.filter((g) => Math.abs(g - medGap) <= Math.max(4, medGap * 0.25));
    if (regular.length / gaps.length < 0.6) continue;

    const amounts = list.map((t) => Number(t.amount));
    const medAmount = median(amounts);
    const amountVar =
      amounts.filter((a) => Math.abs(a - medAmount) <= medAmount * 0.2).length /
      amounts.length;
    if (amountVar < 0.5) continue;

    const merchantName = key.split("::")[0];
    const last = list[list.length - 1];
    const lastDate = new Date(last.date);
    const nextExpected = new Date(lastDate.getTime() + medGap * 86400_000);
    const daysOverdue = (Date.now() - nextExpected.getTime()) / 86400_000;

    const latestAmount = Number(last.amount);
    let status = "active";
    if (daysOverdue > Math.max(5, medGap * 0.5)) status = "missed";
    else if (latestAmount > medAmount * 1.08) status = "price_changed";

    const isSubscription =
      (cadence === "monthly" || cadence === "weekly" || cadence === "annual") &&
      amounts.every((a) => Math.abs(a - medAmount) <= Math.max(1, medAmount * 0.05)) &&
      !(last.category_id && notSubscribable.has(last.category_id));

    const { data: existing } = await db
      .from("recurring_items")
      .select("id, status")
      .eq("merchant", merchantName)
      .eq("account_id", last.account_id)
      .maybeSingle();

    const row = {
      merchant: merchantName,
      category_id: last.category_id,
      cadence,
      expected_amount: Math.round(medAmount * 100) / 100,
      amount_tolerance_pct: 20,
      next_expected_date: nextExpected.toISOString().slice(0, 10),
      account_id: last.account_id,
      is_subscription: isSubscription,
      status,
      last_seen_txn_id: last.id,
    };

    if (existing) {
      // don't resurrect items the user cancelled
      if (existing.status === "cancelled") continue;
      await db.from("recurring_items").update(row).eq("id", existing.id);
    } else {
      await db.from("recurring_items").insert(row);
    }
    touched.add(key);
    found++;
  }

  const reconciled = await reconcileUntouched(db, rows, touched);

  console.log(
    `[recurring] ${found} recurring items detected/updated, ${reconciled} stale items reconciled`
  );
  await audit(db, "system", "recurring_detected", "recurring_items", undefined, {
    count: found,
    reconciled,
  });
}


const CADENCE_DAYS: Record<string, number> = {
  weekly: 7,
  monthly: 30,
  annual: 365,
  custom: 30,
};

/**
 * Keep an item's idea of "last seen" true even after its pattern stops being
 * regular.
 *
 * A merchant that becomes irregular — a phone bill that turns into three small
 * charges a month instead of one predictable one — stops qualifying above, and
 * the loop simply skips it. The row it left behind is then frozen forever at
 * whatever it said the last time the pattern held: due in June, last seen in
 * May, status `missed`, while the merchant carries on charging every week.
 *
 * Nothing complained, because a stale row is a perfectly valid row. It surfaced
 * only when the cash floors started reserving those obligations as overdue and
 * quietly held back money for bills that had in fact been paid three months
 * earlier. An item that is wrong about the past will be wrong about the future,
 * and something downstream will believe it.
 */
async function reconcileUntouched(
  db: SupabaseClient,
  rows: TxnLite[],
  touched: Set<string>
): Promise<number> {
  const latest = new Map<string, TxnLite>();
  for (const t of rows) {
    const name = t.merchant_clean ?? t.merchant;
    if (!name) continue;
    const key = `${name}::${t.account_id}`;
    const cur = latest.get(key);
    if (!cur || t.date > cur.date) latest.set(key, t);
  }

  const { data: items } = await db
    .from("recurring_items")
    .select("id, merchant, account_id, cadence, status, next_expected_date, last_seen_txn_id")
    .in("status", ["active", "price_changed", "missed"]);

  let n = 0;
  for (const item of items ?? []) {
    const key = `${item.merchant}::${item.account_id}`;
    if (touched.has(key)) continue;
    const seen = latest.get(key);
    if (!seen) continue; // genuinely nothing since: `missed` is the truth
    if (seen.id === item.last_seen_txn_id) continue;

    const gap = CADENCE_DAYS[item.cadence ?? "monthly"] ?? 30;
    const next = new Date(new Date(seen.date).getTime() + gap * 86400_000);
    const daysOverdue = (Date.now() - next.getTime()) / 86400_000;
    await db
      .from("recurring_items")
      .update({
        last_seen_txn_id: seen.id,
        next_expected_date: next.toISOString().slice(0, 10),
        // The amount is deliberately not rewritten. The pattern that produced
        // it no longer holds, and one irregular charge is not a better estimate
        // than the median of the run that did.
        status: daysOverdue > Math.max(5, gap * 0.5) ? "missed" : "active",
      })
      .eq("id", item.id);
    n++;
  }
  return n;
}

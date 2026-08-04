import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@finance/shared";

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
  id: string;
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
  const { data: txns } = await db
    .from("transactions")
    .select("id, merchant, merchant_clean, amount, date, account_id, category_id")
    .gte("date", cutoff)
    .gt("amount", 0) // outflows only
    .eq("hidden", false)
    .is("parent_transaction_id", null)
    .order("date");
  if (!txns?.length) return;

  const groups = new Map<string, TxnLite[]>();
  for (const t of txns as TxnLite[]) {
    const name = t.merchant_clean ?? t.merchant;
    if (!name) continue;
    const key = `${name}::${t.account_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  let found = 0;
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
      amounts.every((a) => Math.abs(a - medAmount) <= Math.max(1, medAmount * 0.05));

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
    found++;
  }

  console.log(`[recurring] ${found} recurring items detected/updated`);
  await audit(db, "system", "recurring_detected", "recurring_items", undefined, {
    count: found,
  });
}

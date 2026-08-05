import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@finance/shared";

/**
 * Tell card payments apart from refunds.
 *
 * On a credit account a negative amount is money arriving, which is either a
 * payment against the balance or a refund for returned goods. The descriptor
 * cannot settle it — paying the Walmart card through the Walmart app produces
 * a transaction that just reads "Walmart", identical to a grocery refund — so
 * Plaid files it under Groceries and every such payment silently becomes
 * negative grocery spending.
 *
 * The reliable signal is the other leg: a payment always has a matching
 * outflow from a funding account within a few days. A refund never does.
 * Both legs are then filed as Credit Card Payment, which lives in the transfer
 * group and is therefore excluded from cash flow and budgets — money moving
 * between your own accounts is not income and not an expense.
 */

const WINDOW_DAYS = 5;
const CENTS = 0.005;

export interface CardPaymentFix {
  credit_txn_id: string;
  funding_txn_id: string;
  amount: number;
  merchant: string | null;
  date: string;
  was: string | null;
}

export async function detectCardPayments(
  db: SupabaseClient,
  opts: { apply?: boolean; sinceDays?: number } = {}
): Promise<CardPaymentFix[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 400) * 86400_000)
    .toISOString()
    .slice(0, 10);

  const { data: cat } = await db
    .from("categories")
    .select("id")
    .eq("name", "Credit Card Payment")
    .maybeSingle();
  if (!cat) return [];

  const { data: accounts } = await db.from("accounts").select("id, type");
  const creditIds = new Set(
    (accounts ?? []).filter((a: any) => a.type === "credit").map((a: any) => a.id)
  );
  const fundingIds = new Set(
    (accounts ?? [])
      .filter((a: any) => a.type === "depository" || a.type === "checking" || a.type === "savings")
      .map((a: any) => a.id)
  );
  if (!creditIds.size || !fundingIds.size) return [];

  const { data: rows } = await db
    .from("transactions")
    .select("id, account_id, date, amount, merchant, category_id, category_source")
    .gte("date", since)
    .eq("hidden", false)
    .limit(20000);

  // Inflows on a credit card: candidate payments (or refunds).
  const inflows = (rows ?? []).filter(
    (t: any) => creditIds.has(t.account_id) && Number(t.amount) < 0
  );
  // Outflows from a funding account: the other leg of a payment.
  const outflows = (rows ?? []).filter(
    (t: any) => fundingIds.has(t.account_id) && Number(t.amount) > 0
  );

  const used = new Set<string>();
  const fixes: CardPaymentFix[] = [];

  for (const inflow of inflows) {
    const target = Math.abs(Number(inflow.amount));
    const day = Date.parse(`${inflow.date}T00:00:00Z`);

    // Nearest same-amount outflow within the window, each leg used once so two
    // identical payments in a month cannot both claim the same funding row.
    const match = outflows
      .filter((o: any) => !used.has(o.id) && Math.abs(Number(o.amount) - target) < CENTS)
      .map((o: any) => ({ o, gap: Math.abs(Date.parse(`${o.date}T00:00:00Z`) - day) }))
      .filter((m) => m.gap <= WINDOW_DAYS * 86400_000)
      .sort((a, b) => a.gap - b.gap)[0];
    if (!match) continue;

    used.add(match.o.id);
    fixes.push({
      credit_txn_id: inflow.id,
      funding_txn_id: match.o.id,
      amount: target,
      merchant: inflow.merchant,
      date: inflow.date,
      was: inflow.category_id ?? null,
    });

    if (opts.apply) {
      for (const id of [inflow.id, match.o.id]) {
        await db
          .from("transactions")
          .update({ category_id: cat.id, category_source: "rule", needs_review: false })
          .eq("id", id);
      }
    }
  }

  if (opts.apply && fixes.length) {
    await audit(db, "system", "card_payments_recategorized", "transactions", undefined, {
      pairs: fixes.length,
      total: fixes.reduce((s, f) => s + f.amount, 0),
    });
  }

  return fixes;
}

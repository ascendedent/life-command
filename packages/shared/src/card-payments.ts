/**
 * Match a payment leaving checking to the credit that lands on the card.
 *
 * A card payment is one dollar moving between two accounts the owner already
 * holds, so it must not count as spending. Plaid usually names the checking
 * side after the issuer rather than the card — "State Farm" for a State Farm
 * Bank card, "Discover" for a Discover card — and its own classifier then reads
 * that as a merchant. One such payment was filed as Insurance and counted
 * twice: once as money spent leaving checking, once as a transfer arriving on
 * the card. Categorisation cannot see this on its own, because the two legs
 * live on different accounts and only make sense together.
 *
 * The match is deliberately narrow. An exact amount, a few days apart, and a
 * card-side row that already reads as money movement. Two unrelated
 * transactions agreeing to the cent within that window is rare, though round
 * numbers do collide; treating an ordinary purchase as a transfer would erase
 * real spending from the budget, which is the more expensive mistake.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { looksLikeMoneyMovement } from "./categorize";

/** Days either side of the checking debit to look for the card-side credit. */
const WINDOW_DAYS = 4;

interface Row {
  id: string;
  account_id: string;
  date: string;
  amount: number | string;
  merchant_clean: string | null;
  category_id: string | null;
  categories: { name?: string; category_groups?: { type?: string } } | null;
}

export interface LinkResult {
  linked: number;
  pairs: { date: string; amount: number; merchant: string | null; card: string }[];
}

const dayDiff = (a: string, b: string) =>
  Math.abs(
    (new Date(a + "T00:00:00").getTime() - new Date(b + "T00:00:00").getTime()) / 86_400_000
  );

export async function linkCardPayments(
  db: SupabaseClient,
  opts: { since?: string; dryRun?: boolean } = {}
): Promise<LinkResult> {
  const since = opts.since ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

  const [{ data: cat }, { data: accounts }] = await Promise.all([
    db.from("categories").select("id").eq("name", "Credit Card Payment").single(),
    db.from("accounts").select("id, name, mask, type"),
  ]);
  if (!cat) return { linked: 0, pairs: [] };

  const cards = new Set(
    (accounts ?? []).filter((a) => a.type === "credit").map((a) => a.id as string)
  );
  const cash = new Set(
    (accounts ?? []).filter((a) => a.type === "depository").map((a) => a.id as string)
  );
  const label = new Map(
    (accounts ?? []).map((a) => [a.id as string, `${a.name} ‥${a.mask ?? "????"}`])
  );
  if (!cards.size || !cash.size) return { linked: 0, pairs: [] };

  // Paginated: PostgREST caps a response at 1000 rows regardless of any limit
  // asked for, and a silently truncated window here would mean pairs that exist
  // are simply never seen — the matcher would report nothing and look correct.
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("transactions")
      .select("id, account_id, date, amount, merchant_clean, category_id, categories (name, category_groups (type))")
      .eq("hidden", false)
      .gte("date", since)
      .order("date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as Row[]));
    if ((data?.length ?? 0) < 1000) break;
  }

  // Card-side credits that already read as money arriving to settle a balance.
  const credits = (rows ?? [])
    .filter((t) => cards.has(t.account_id) && Number(t.amount) < 0)
    .filter((t) => {
      const group = t.categories?.category_groups?.type;
      return group === "transfer" || looksLikeMoneyMovement(t.merchant_clean ?? "");
    })
    .map((t) => ({ ...t, amt: Math.abs(Number(t.amount)) }));

  // Checking-side debits not already recorded as a card payment.
  const debits = (rows ?? [])
    .filter((t) => cash.has(t.account_id) && Number(t.amount) > 0)
    // Only rows that currently count as spending are worth touching. A debit
    // already in the transfer group is excluded from budgets either way, so
    // relabelling it buys nothing and risks acting on a coincidence — round
    // figures turn up on both sides of a ledger by chance.
    .filter((t) => t.categories?.category_groups?.type !== "transfer")
    .map((t) => ({ ...t, amt: Number(t.amount) }));

  const used = new Set<string>();
  const pairs: LinkResult["pairs"] = [];
  const toUpdate: string[] = [];

  for (const d of debits) {
    const hit = credits
      .filter((c) => !used.has(c.id) && c.amt === d.amt)
      .filter((c) => dayDiff(c.date, d.date) <= WINDOW_DAYS)
      .sort((a, b) => dayDiff(a.date, d.date) - dayDiff(b.date, d.date))[0];
    if (!hit) continue;
    used.add(hit.id);
    toUpdate.push(d.id);
    pairs.push({
      date: d.date,
      amount: d.amt,
      merchant: d.merchant_clean,
      card: label.get(hit.account_id) ?? "?",
    });
  }

  if (!opts.dryRun && toUpdate.length) {
    for (let i = 0; i < toUpdate.length; i += 100) {
      const ids = toUpdate.slice(i, i + 100);
      await db
        .from("transactions")
        .update({ category_id: cat.id, category_source: "rule", needs_review: false })
        .in("id", ids);
    }
    await db.from("audit_log").insert({
      actor: "system",
      action: "card_payments_linked",
      entity: "transactions",
      detail: { linked: toUpdate.length, since, pairs: pairs.slice(0, 50) },
    });
  }

  return { linked: toUpdate.length, pairs };
}

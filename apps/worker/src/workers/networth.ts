import type { SupabaseClient } from "@supabase/supabase-js";

/** Write today's net worth snapshot from current account balances. */
export async function snapshotNetWorth(db: SupabaseClient): Promise<void> {
  const { data: accounts } = await db
    .from("accounts")
    .select("type, current_balance");
  if (!accounts?.length) return;

  const byType: Record<string, number> = {};
  let total = 0;
  for (const a of accounts) {
    const bal = Number(a.current_balance ?? 0);
    const isDebt = a.type === "credit" || a.type === "loan";
    byType[a.type] = (byType[a.type] ?? 0) + (isDebt ? -bal : bal);
    total += isDebt ? -bal : bal;
  }

  const today = new Date().toISOString().slice(0, 10);
  await db.from("net_worth_snapshots").upsert(
    {
      date: today,
      total: Math.round(total * 100) / 100,
      by_account_type: byType,
    },
    { onConflict: "date" }
  );
}

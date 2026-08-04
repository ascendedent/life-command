import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@finance/shared";
import {
  dedupeMatches,
  matchContributions,
  type ContributionMatch,
  type GoalLink,
} from "@finance/shared/src/goals";
import type { ReportTxn } from "@finance/shared/src/reports";

const LOOKBACK_MONTHS = 24;

/**
 * Re-derives every goal's auto-matched contributions from its links, then
 * refreshes `goals.current_amount`.
 *
 * Idempotent by design: it recomputes the full matched set each run and removes
 * auto rows that no longer match (the user narrowed a link, recategorized a
 * transaction, deleted one). Manual attachments are never touched.
 */
export async function matchGoalContributions(db: SupabaseClient): Promise<number> {
  const { data: goals } = await db
    .from("goals")
    .select("id, name, status")
    .neq("status", "archived");
  if (!goals?.length) return 0;

  const { data: allLinks } = await db.from("goal_links").select("*");
  const linksByGoal = new Map<string, GoalLink[]>();
  for (const l of (allLinks ?? []) as GoalLink[]) {
    const list = linksByGoal.get(l.goal_id!) ?? [];
    list.push(l);
    linksByGoal.set(l.goal_id!, list);
  }

  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - LOOKBACK_MONTHS);
  const from = since.toISOString().slice(0, 10);

  const [{ data: txnRows }, { data: accounts }, { data: cats }, { data: tags }] = await Promise.all([
    db
      .from("transactions")
      .select("id, date, amount, merchant, merchant_clean, category_id, account_id, transaction_tags (tag_id)")
      .gte("date", from)
      // hidden=false counts each dollar once — a split hides the parent.
      .eq("hidden", false)
      .order("date", { ascending: false })
      .limit(20000),
    db.from("accounts").select("id, name"),
    db.from("categories").select("id, name"),
    db.from("tags").select("id, name"),
  ]);

  const tagsByTxn = new Map<string, Set<string>>();
  const txns: ReportTxn[] = (txnRows ?? []).map((t: any) => {
    const links = (t.transaction_tags ?? []) as { tag_id: string }[];
    if (links.length) tagsByTxn.set(t.id, new Set(links.map((l) => l.tag_id)));
    return {
      id: t.id,
      date: t.date,
      amount: Number(t.amount),
      merchant: t.merchant,
      merchant_clean: t.merchant_clean,
      category_id: t.category_id,
      account_id: t.account_id,
    };
  });

  const ctx = {
    tagsByTxn,
    accountNames: new Map((accounts ?? []).map((a: any) => [a.id, a.name])),
    categoryNames: new Map((cats ?? []).map((c: any) => [c.id, c.name])),
    tagNames: new Map((tags ?? []).map((t: any) => [t.id, t.name])),
  };

  let touched = 0;

  for (const goal of goals) {
    const links = linksByGoal.get(goal.id) ?? [];
    const matches: ContributionMatch[] = links.length
      ? dedupeMatches(matchContributions(txns, links, ctx))
      : [];
    const matchedIds = new Set(matches.map((m) => m.transaction_id));

    const { data: existing } = await db
      .from("goal_contributions")
      .select("id, transaction_id, source, amount")
      .eq("goal_id", goal.id);

    // Drop auto rows the current linkage no longer produces.
    const stale = (existing ?? []).filter(
      (row: any) => row.source !== "manual" && (!row.transaction_id || !matchedIds.has(row.transaction_id))
    );
    if (stale.length) {
      await db
        .from("goal_contributions")
        .delete()
        .in("id", stale.map((r: any) => r.id));
    }

    const manualTxnIds = new Set(
      (existing ?? []).filter((r: any) => r.source === "manual" && r.transaction_id).map((r: any) => r.transaction_id)
    );

    const rows = matches
      .filter((m) => !manualTxnIds.has(m.transaction_id)) // a manual attach wins
      .map((m) => ({
        goal_id: goal.id,
        transaction_id: m.transaction_id,
        amount: m.amount,
        occurred_at: `${m.date}T12:00:00Z`,
        source: "auto",
        via: m.via,
      }));

    if (rows.length) {
      const { error } = await db
        .from("goal_contributions")
        .upsert(rows, { onConflict: "goal_id,transaction_id", ignoreDuplicates: false });
      if (error) {
        console.error(`[goals] upsert failed for ${goal.name}: ${error.message}`);
        continue;
      }
    }

    const { data: fresh } = await db
      .from("goal_contributions")
      .select("amount")
      .eq("goal_id", goal.id);
    const total = (fresh ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    await db
      .from("goals")
      .update({ current_amount: Math.round(total * 100) / 100 })
      .eq("id", goal.id);

    touched += rows.length;
    console.log(
      `[goals] ${goal.name}: ${matches.length} matched, ${stale.length} stale removed, balance ${total.toFixed(2)}`
    );
  }

  await audit(db, "system", "goal_match", "goal_contributions", undefined, {
    goals: goals.length,
    contributions: touched,
  });
  return touched;
}

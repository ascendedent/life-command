import { NextResponse } from "next/server";
import { ruleMatches, type TxnRule } from "@finance/shared";
import { requireOwner } from "@/lib/api-auth";

// Retroactive rule apply with preview (spec §1.6). dry_run returns the count
// and a sample; a real run updates matches. User-categorized rows are never
// overwritten.

export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  if (!body?.rule_id) {
    return NextResponse.json({ error: "rule_id required" }, { status: 400 });
  }
  const dryRun = body.dry_run !== false;

  const { data: rule } = await supabase
    .from("txn_rules")
    .select("id, priority, criteria, actions")
    .eq("id", body.rule_id)
    .maybeSingle();
  if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });

  const { data: txns } = await supabase
    .from("transactions")
    .select("id, merchant, amount, account_id, date, category_source")
    .neq("category_source", "user")
    .is("parent_transaction_id", null)
    .order("date", { ascending: false })
    .limit(5000);

  const matches = (txns ?? []).filter((t) =>
    ruleMatches(rule as TxnRule, {
      merchant: t.merchant,
      amount: Number(t.amount),
      account_id: t.account_id,
      pfc_primary: null,
      pfc_detailed: null,
    })
  );

  if (dryRun) {
    return NextResponse.json({
      count: matches.length,
      sample: matches.slice(0, 10).map((t) => ({
        id: t.id,
        merchant: t.merchant,
        amount: t.amount,
        date: t.date,
      })),
    });
  }

  const a = (rule as TxnRule).actions ?? {};
  const patch: Record<string, unknown> = {};
  if (a.set_category_id) {
    patch.category_id = a.set_category_id;
    patch.category_source = "rule";
  }
  if (a.rename_merchant) patch.merchant_clean = a.rename_merchant;
  if (a.hide != null) patch.hidden = a.hide;
  if (a.needs_review != null) patch.needs_review = a.needs_review;

  let applied = 0;
  if (Object.keys(patch).length > 0) {
    for (let i = 0; i < matches.length; i += 100) {
      const ids = matches.slice(i, i + 100).map((t) => t.id);
      const { error } = await supabase.from("transactions").update(patch).in("id", ids);
      if (!error) applied += ids.length;
    }
  }

  await supabase
    .from("txn_rules")
    .update({ hit_count: applied, last_hit_at: new Date().toISOString() })
    .eq("id", rule.id);

  await supabase.from("audit_log").insert({
    actor: "user",
    action: "rule_applied_retroactively",
    entity: "txn_rules",
    entity_id: rule.id,
    detail: { applied },
  });

  return NextResponse.json({ applied });
}

import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "bad body" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (typeof body.is_business === "boolean") patch.is_business = body.is_business;
  if ("business_entity" in body) patch.business_entity = body.business_entity || null;
  if (typeof body.is_agent_controlled === "boolean") {
    patch.is_agent_controlled = body.is_agent_controlled;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  // Exactly one account may be agent-controlled, so this is a radio and not a
  // checkbox: naming one unnames the rest. Two flagged accounts disable trading
  // entirely — the agent must never choose which account an order lands in —
  // and a UI that can reach that state is a UI that turns trading off by
  // accident and gives no hint why.
  if (patch.is_agent_controlled === true) {
    await supabase
      .from("accounts")
      .update({ is_agent_controlled: false })
      .eq("is_agent_controlled", true)
      .neq("id", params.id);
  }

  const { error } = await supabase.from("accounts").update(patch).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Business default stamps every txn on the account (spec §1.6): apply to
  // already-synced history too, but never overwrite user-set business flags.
  //
  // `business_source` is NULL on every ordinary transaction, and `neq` never
  // matches NULL — so the backfill matched nothing and flagging an account did
  // precisely nothing to the history it was meant to claim. Spell out the
  // sources we may overwrite, the same way the enrichment pass has to.
  if (patch.is_business === true) {
    await supabase
      .from("transactions")
      .update({
        is_business: true,
        business_source: "account_default",
        business_entity: (patch.business_entity as string) ?? null,
        receipt_status: "requested",
      })
      .eq("account_id", params.id)
      .or("business_source.is.null,business_source.eq.account_default");
  } else if (patch.is_business === false) {
    await supabase
      .from("transactions")
      .update({
        is_business: false,
        business_source: null,
        business_entity: null,
        receipt_status: null,
      })
      .eq("account_id", params.id)
      .eq("business_source", "account_default");
  }

  await supabase.from("audit_log").insert({
    actor: "user",
    action: "account_updated",
    entity: "accounts",
    entity_id: params.id,
    detail: patch,
  });

  return NextResponse.json({ ok: true });
}

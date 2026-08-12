import { NextResponse } from "next/server";
import { createPlaidClient, encryptSecret } from "@finance/shared";
import { requireOwner } from "@/lib/api-auth";

export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  if (!body?.public_token) {
    return NextResponse.json({ error: "public_token required" }, { status: 400 });
  }

  const plaid = createPlaidClient();
  try {
    const exchange = await plaid.itemPublicTokenExchange({
      public_token: body.public_token,
    });
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    const { data: inst, error: instErr } = await supabase
      .from("institutions")
      .upsert(
        {
          plaid_item_id: itemId,
          plaid_institution_id: body.institution?.institution_id ?? null,
          name: body.institution?.name ?? "Institution",
          status: "ok",
          access_token_enc: encryptSecret(accessToken),
        },
        { onConflict: "plaid_item_id" }
      )
      .select("id")
      .single();
    if (instErr || !inst) {
      return NextResponse.json(
        { error: instErr?.message ?? "institution insert failed" },
        { status: 500 }
      );
    }

    // Pull accounts immediately so the business-flag step has data
    const accountsRes = await plaid.accountsGet({ access_token: accessToken });
    for (const a of accountsRes.data.accounts) {
      await supabase.from("accounts").upsert(
        {
          institution_id: inst.id,
          plaid_account_id: a.account_id,
          name: a.name,
          type: a.type,
          subtype: a.subtype ?? null,
          mask: a.mask ?? null,
          current_balance: a.balances.current,
          available_balance: a.balances.available,
          // Whoever this bank was linked as owns the accounts behind it. Any
          // of them can be reassigned afterwards — a joint account may belong
          // to the household rather than to the person who logged in.
          ...(body.member_id ? { member_id: body.member_id } : {}),
        },
        { onConflict: "plaid_account_id" }
      );
    }

    const { data: accounts } = await supabase
      .from("accounts")
      .select("id, name, type, subtype, mask, is_business, business_entity")
      .eq("institution_id", inst.id)
      .order("name");

    // Queue the initial backfill for the worker
    await supabase.from("sync_jobs").insert({
      type: "sync_item",
      institution_id: inst.id,
      requested_by: "system",
    });

    await supabase.from("audit_log").insert({
      actor: "user",
      action: "institution_linked",
      entity: "institutions",
      entity_id: inst.id,
      detail: {
        name: body.institution?.name,
        accounts: accounts?.length ?? 0,
        member_id: body.member_id ?? null,
      },
    });

    return NextResponse.json({ institution_id: inst.id, accounts: accounts ?? [] });
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error_message?: string } }; message: string };
    const msg = err.response?.data?.error_message ?? err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

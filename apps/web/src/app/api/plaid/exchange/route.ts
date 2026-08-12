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

    // A card two people can both see is one card. Linking it under each of
    // their logins produces two Plaid Items, and Plaid issues a *different*
    // account_id per Item — so the unique constraint on plaid_account_id does
    // not fire, and the same balance and the same transactions land twice.
    // A shared Quicksilver did exactly that: net worth was wrong by the full
    // balance and every charge on it was counted twice.
    //
    // Matched on institution, mask, type and name together. Mask alone is not
    // enough — a loan and a savings account at the same credit union can share
    // the last four and be entirely different accounts.
    const { data: known } = await supabase
      .from("accounts")
      .select("id, name, type, mask, institution_id, institutions (name, plaid_institution_id), household_members (name)")
      .neq("institution_id", inst.id);
    const dupeKey = (institution: string | null, mask: string | null, type: string, name: string) =>
      `${(institution ?? "").toLowerCase()}|${mask ?? ""}|${type}|${name.toLowerCase()}`;
    const seen = new Map<string, string>();
    for (const k of known ?? []) {
      const kInst = k.institutions as unknown as { name: string; plaid_institution_id: string | null } | null;
      const holder = (k.household_members as unknown as { name: string } | null)?.name ?? "another login";
      seen.set(
        dupeKey(kInst?.plaid_institution_id ?? kInst?.name ?? null, k.mask, k.type, k.name),
        holder
      );
    }

    const duplicates: { name: string; mask: string | null; already_under: string }[] = [];
    const thisInstitutionKey =
      body.institution?.institution_id ?? body.institution?.name ?? null;

    for (const a of accountsRes.data.accounts) {
      const key = dupeKey(thisInstitutionKey, a.mask ?? null, a.type, a.name);
      const heldBy = seen.get(key);
      if (heldBy) {
        // Not created at all. Storing it and excluding it later would mean
        // every money query having to remember to exclude it, and one that
        // forgot would be wrong in a way nobody would notice.
        duplicates.push({ name: a.name, mask: a.mask ?? null, already_under: heldBy });
        continue;
      }
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
        duplicates_skipped: duplicates.length,
      },
    });

    return NextResponse.json({
      institution_id: inst.id,
      accounts: accounts ?? [],
      duplicates,
    });
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error_message?: string } }; message: string };
    const msg = err.response?.data?.error_message ?? err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

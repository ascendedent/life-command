import { NextResponse } from "next/server";
import { CountryCode, Products } from "plaid";
import { createPlaidClient } from "@finance/shared";
import { requireOwner } from "@/lib/api-auth";

export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => ({}));
  const plaid = createPlaidClient();

  try {
    // Relink/update mode when an institution id is provided
    let accessToken: string | undefined;
    if (body.institution_id) {
      const { data: inst } = await guard.supabase
        .from("institutions")
        .select("access_token_enc")
        .eq("id", body.institution_id)
        .maybeSingle();
      if (inst?.access_token_enc) {
        const { decryptSecret } = await import("@finance/shared");
        accessToken = decryptSecret(inst.access_token_enc);
      }
    }

    // Plaid keys its returning-user experience off client_user_id: send the
    // same one every time and Link recognises the owner, offers their saved
    // institutions, and pre-fills their details — which is exactly wrong when
    // the person at the keyboard is linking a partner's bank. A member-scoped
    // id makes each person a separate end user, so Link starts clean for them.
    // It stays a pair of opaque uuids; no personal detail is sent to Plaid.
    const endUserId = body.member_id
      ? `${guard.user.id}:${body.member_id}`
      : guard.user.id;

    const res = await plaid.linkTokenCreate({
      user: { client_user_id: endUserId },
      client_name: "Life Command",
      language: "en",
      country_codes: [CountryCode.Us],
      ...(accessToken
        ? { access_token: accessToken }
        : {
            products: [Products.Transactions],
            optional_products: [Products.Investments, Products.Liabilities],
            transactions: { days_requested: 730 },
          }),
    });
    return NextResponse.json({ link_token: res.data.link_token });
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error_message?: string } }; message: string };
    const msg = err.response?.data?.error_message ?? err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

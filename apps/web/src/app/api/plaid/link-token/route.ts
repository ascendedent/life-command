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

    const res = await plaid.linkTokenCreate({
      user: { client_user_id: guard.user.id },
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

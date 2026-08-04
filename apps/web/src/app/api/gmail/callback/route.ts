import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { encryptSecret } from "@finance/shared";
import { requireOwner } from "@/lib/api-auth";

export async function GET(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const savedState = cookies().get("gmail_oauth_state")?.value;

  if (!code || !state || state !== savedState) {
    return NextResponse.redirect(`${url.origin}/account?gmail=error`);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}/api/gmail/callback`,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.refresh_token) {
    console.error("[gmail] token exchange failed:", tokens.error ?? tokenRes.status);
    return NextResponse.redirect(`${url.origin}/account?gmail=error`);
  }

  // identify the connected mailbox — required, it's the connection key
  let email: string | null = null;
  try {
    const profile = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    ).then((r) => r.json());
    email = profile.emailAddress ?? null;
  } catch {
    // fall through to error redirect
  }
  if (!email) {
    return NextResponse.redirect(`${url.origin}/account?gmail=error`);
  }

  await supabase.from("connections").upsert(
    {
      provider: "gmail",
      account_email: email,
      refresh_token_enc: encryptSecret(tokens.refresh_token),
      status: "ok",
      last_error: null,
    },
    { onConflict: "provider,account_email" }
  );
  await supabase.from("audit_log").insert({
    actor: "user",
    action: "gmail_connected",
    entity: "connections",
    detail: { email },
  });

  return NextResponse.redirect(`${url.origin}/account?gmail=connected`);
}

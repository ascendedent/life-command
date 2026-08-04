import { NextResponse } from "next/server";
import { decryptSecret } from "@finance/shared";
import { requireOwner } from "@/lib/api-auth";

// Lists a connected mailbox's labels so the UI can offer direct label→receipt
// mapping instead of hand-written queries.

export async function GET(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data: conn } = await supabase
    .from("connections")
    .select("refresh_token_enc")
    .eq("id", id)
    .maybeSingle();
  if (!conn) return NextResponse.json({ error: "not found" }, { status: 404 });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: decryptSecret(conn.refresh_token_enc),
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    return NextResponse.json({ error: tokens.error ?? "token refresh failed" }, { status: 502 });
  }

  const labelsRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );
  const data = await labelsRes.json();
  if (!labelsRes.ok) {
    return NextResponse.json({ error: "labels fetch failed" }, { status: 502 });
  }

  const labels = ((data.labels ?? []) as { id: string; name: string; type: string }[])
    .filter((l) => l.type === "user")
    .map((l) => l.name)
    .sort((a, b) => a.localeCompare(b));

  return NextResponse.json({ labels });
}

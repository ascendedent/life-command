import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireOwner } from "@/lib/api-auth";

// Starts the Google OAuth flow (gmail.readonly only, spec §1.7 Path B).

export async function GET(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GOOGLE_CLIENT_ID not configured — add it to .env and run env:sync" },
      { status: 500 }
    );
  }

  const origin = new URL(request.url).origin;
  const state = randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/gmail/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent", // ensures a refresh_token is issued
    state,
  });

  const response = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  );
  response.cookies.set("gmail_oauth_state", state, {
    httpOnly: true,
    maxAge: 600,
    path: "/api/gmail",
  });
  return response;
}

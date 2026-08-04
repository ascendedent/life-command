import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Route-handler guard: authenticated owner at aal2, or a 401. */
export async function requireOwner() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    return { error: NextResponse.json({ error: "mfa required" }, { status: 401 }) };
  }
  return { supabase, user };
}

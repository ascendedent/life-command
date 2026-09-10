import { NextResponse } from "next/server";
import { rewardsPlan } from "@finance/shared";
import { requireOwner } from "@/lib/api-auth";

/**
 * The card plan is computed here rather than in the page.
 *
 * `@finance/shared` re-exports the LLM client, which reaches for node:crypto
 * and node:child_process. Importing anything from the package barrel into a
 * client component drags those into the browser bundle and the build fails.
 * Running it server-side also keeps the query under the owner's RLS session.
 */
export async function GET() {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;

  try {
    return NextResponse.json(await rewardsPlan(guard.supabase));
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

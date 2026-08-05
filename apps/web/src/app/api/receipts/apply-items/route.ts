import { NextResponse } from "next/server";
import { applyReceiptItems } from "@finance/shared";
import { requireOwner } from "@/lib/api-auth";

/**
 * Apply a receipt's parsed basket to the transaction it was matched to.
 *
 * The worker does this automatically when it reconciles, but a receipt the
 * owner matches by hand deserves the same treatment — otherwise the mixed
 * Walmart charge you just confirmed stays filed as one lump.
 */
export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  if (!body?.receipt_id || !body?.transaction_id) {
    return NextResponse.json(
      { error: "receipt_id and transaction_id required" },
      { status: 400 }
    );
  }

  const outcome = await applyReceiptItems(supabase, body.receipt_id, body.transaction_id);
  return NextResponse.json({ outcome });
}

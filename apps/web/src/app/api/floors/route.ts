import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";
import { evaluateFloors, loadFloorState, type Floor } from "@finance/shared";

/** The owner's floors and where they stand today. */
export async function GET() {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const [{ data: rows }, { data: accounts }] = await Promise.all([
    supabase.from("agent_floors").select("*").order("kind"),
    supabase
      .from("accounts")
      .select("id, name, mask, type")
      .in("type", ["depository", "credit", "investment"])
      .order("name"),
  ]);
  const floors = (rows ?? []) as Floor[];
  const state = await loadFloorState(supabase);
  // No delta: this is where the owner stands right now, not after anything.
  const { readings } = evaluateFloors(floors, state, null);

  return NextResponse.json({
    floors,
    readings,
    accounts: accounts ?? [],
    // Surfaced rather than inferred: a committed-cash reservation computed from
    // zero dated obligations is not a reservation, and $0 does not say so.
    obligations: state.obligationCoverage,
    monthlyExpenses: state.monthlyExpenses,
  });
}

export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  if (!body?.kind) return NextResponse.json({ error: "bad body" }, { status: 400 });

  const row = {
    kind: body.kind,
    account_id: body.account_id ?? null,
    amount: body.amount === "" || body.amount == null ? null : Number(body.amount),
    pct: body.pct === "" || body.pct == null ? null : Number(body.pct),
    months: body.months === "" || body.months == null ? null : Number(body.months),
    horizon_days: Number(body.horizon_days ?? 14),
    enabled: body.enabled ?? true,
    note: body.note || null,
  };

  // One floor of each kind per account, so "raise my minimum" edits the rule
  // rather than adding a second one that silently contradicts the first.
  const { error } = await supabase
    .from("agent_floors")
    .upsert(row, { onConflict: "kind,account_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await supabase.from("audit_log").insert({
    actor: "user",
    action: "floor_changed",
    entity: "agent_floors",
    detail: row,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase.from("agent_floors").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await supabase.from("audit_log").insert({
    actor: "user", action: "floor_removed", entity: "agent_floors", entity_id: id, detail: {},
  });
  return NextResponse.json({ ok: true });
}

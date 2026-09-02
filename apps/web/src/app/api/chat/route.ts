import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";
import {
  chat,
  evaluateFloors,
  fetchAll,
  loadFloorState,
  resolveLlmSettings,
  type ChatTurn,
  type Floor,
} from "@finance/shared";

/**
 * Build what the assistant is allowed to know.
 *
 * The same masking rule the agent works under: an account is a name and a
 * last-four, never a full identifier. Transfers are excluded from spending
 * because the same dollar moving between the owner's own accounts is not an
 * expense, and `hidden = false` alone counts each dollar once — a split hides
 * its parent, so filtering on the parent as well would drop every split.
 */
async function buildContext(supabase: Parameters<typeof loadFloorState>[0]) {
  const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const [{ data: accounts }, { data: goals }, { data: recurring }, { data: floorRows }, txns] =
    await Promise.all([
      supabase
        .from("accounts")
        .select("name, mask, type, subtype, current_balance, household_members (name)"),
      supabase.from("goals").select("name, type, target_amount, current_amount, target_date, status"),
      supabase
        .from("recurring_items")
        .select("merchant, cadence, expected_amount, next_expected_date, status")
        .in("status", ["active", "price_changed", "missed"]),
      supabase.from("agent_floors").select("*"),
      fetchAll<Record<string, unknown>>(() =>
        supabase
          .from("transactions")
          .select("date, amount, merchant_clean, merchant, id, categories (name, category_groups (type))")
          .gte("date", since)
          .eq("hidden", false)
          .order("date")
          .order("id")
      ),
    ]);

  const round = (n: number) => Math.round(n * 100) / 100;
  const byCategory = new Map<string, number>();
  const byMonth = new Map<string, { in: number; out: number }>();
  for (const t of txns) {
    const amt = Number(t.amount);
    const cat = t.categories as { name?: string; category_groups?: { type?: string } } | null;
    if (cat?.category_groups?.type === "transfer") continue;
    const m = String(t.date).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { in: 0, out: 0 });
    if (amt > 0) {
      byMonth.get(m)!.out += amt;
      byCategory.set(cat?.name ?? "Uncategorized", (byCategory.get(cat?.name ?? "Uncategorized") ?? 0) + amt);
    } else {
      byMonth.get(m)!.in += -amt;
    }
  }

  const rows = accounts ?? [];
  const sum = (pred: (a: (typeof rows)[number]) => boolean) =>
    round(rows.filter(pred).reduce((s, a) => s + Number(a.current_balance ?? 0), 0));

  const floors = (floorRows ?? []) as Floor[];
  const floorReadings = floors.length
    ? evaluateFloors(floors, await loadFloorState(supabase), null).readings.map((r) => ({
        floor: r.label,
        currently: round(r.projected),
        limit: round(r.limit),
        headroom: round(r.headroom),
        within: r.ok,
        measurable: r.evaluable,
      }))
    : [];

  return {
    as_of: new Date().toISOString().slice(0, 10),
    totals: {
      liquid: sum((a) => a.type === "depository"),
      credit_balances: sum((a) => a.type === "credit"),
      loan_balances: sum((a) => a.type === "loan"),
      investments: sum((a) => a.type === "investment"),
    },
    accounts: rows.map((a) => ({
      label: `${a.name} ‥${a.mask ?? "????"}`,
      type: a.type,
      subtype: a.subtype,
      balance: a.current_balance,
      member: (a.household_members as { name?: string } | null)?.name ?? null,
    })),
    cash_flow_by_month: [...byMonth.entries()].sort().map(([month, v]) => ({
      month,
      inflow: round(v.in),
      outflow: round(v.out),
      net: round(v.in - v.out),
    })),
    spend_by_category_90d: [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([category, total]) => ({ category, total: round(total) })),
    floors: floorReadings,
    goals: goals ?? [],
    recurring: recurring ?? [],
  };
}

const SYSTEM = `You are the conversational side of a self-hosted personal finance platform with exactly one user, its owner. They are asking about their own money.

- A snapshot of their finances is provided as JSON. Answer from it. If the snapshot does not contain what was asked, say so plainly rather than estimating — "that isn't in what I can see" is a good answer.
- Refer to an account by its exact \`label\`. Never pair an account name with a last-four yourself: several accounts share a name and differ only by mask.
- Positive transaction amounts are outflows; negative are inflows.
- \`floors\` are limits the owner set on their own balance sheet, not suggestions. Never advise anything that would breach one, and never describe a floor's headroom as spare money without saying what it is holding back.
- You are advisory. You cannot move money, place trades or change settings; if asked to, say what you would do and where in the app to do it.
- Be direct and brief. This is a conversation, not a report — no preamble, no restating the question.`;

export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  const settings = await resolveLlmSettings(supabase, "chat");

  // Resume a thread or start one. The title is the first question, trimmed —
  // good enough to find it again, and cheaper than asking a model to name it.
  let conversationId: string | null = body?.conversation_id ?? null;
  if (!conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        title: message.slice(0, 80),
        provider: settings.provider,
        model: settings.model,
      })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    conversationId = data.id;
  }

  const { data: history } = await supabase
    .from("conversation_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at")
    .limit(40);

  await supabase
    .from("conversation_messages")
    .insert({ conversation_id: conversationId, role: "user", content: message });

  const context = await buildContext(supabase);
  const turns: ChatTurn[] = [
    ...((history ?? []) as ChatTurn[]),
    { role: "user", content: message },
  ];

  const result = await chat(
    settings,
    `${SYSTEM}\n\nSnapshot:\n${JSON.stringify(context)}`,
    turns
  );

  // Recorded even when it failed, so a thread reads honestly rather than
  // silently skipping the turn that did not work.
  await supabase.from("conversation_messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: result.reply ?? "",
    tokens: result.tokens,
    context,
    error: result.error ?? null,
  });
  await supabase
    .from("conversations")
    .update({ provider: settings.provider, model: settings.model })
    .eq("id", conversationId);

  return NextResponse.json({
    conversation_id: conversationId,
    reply: result.reply,
    error: result.error ?? null,
    provider: settings.provider,
    model: result.model,
    tokens: result.tokens,
  });
}

/** Thread list, or one thread's messages. */
export async function GET(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;
  const id = new URL(request.url).searchParams.get("conversation_id");

  if (!id) {
    const { data } = await supabase
      .from("conversations")
      .select("id, title, provider, model, updated_at")
      .order("updated_at", { ascending: false })
      .limit(30);
    return NextResponse.json({ conversations: data ?? [] });
  }

  const { data } = await supabase
    .from("conversation_messages")
    .select("id, role, content, error, created_at")
    .eq("conversation_id", id)
    .order("created_at");
  return NextResponse.json({ messages: data ?? [] });
}

import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";
import {
  ATTACHMENT_TYPES,
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  chat,
  evaluateFloors,
  fetchAll,
  historyRange,
  loadFloorState,
  resolveLlmSettings,
  type ChatTurn,
  type Floor,
  type LlmAttachment,
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

  const [{ data: accounts }, { data: goals }, { data: recurring }, { data: floorRows }, { data: liabilities }, txns] =
    await Promise.all([
      supabase
        .from("accounts")
        .select("id, name, mask, type, subtype, current_balance, household_members (name)"),
      supabase.from("goals").select("name, type, target_amount, current_amount, target_date, status"),
      supabase
        .from("recurring_items")
        .select("merchant, cadence, expected_amount, next_expected_date, status")
        .in("status", ["active", "price_changed", "missed"]),
      supabase.from("agent_floors").select("*"),
      // Rates and statement balances are reachable through `list_accounts`;
      // only the count is worth carrying, so the model knows they exist.
      supabase.from("liabilities").select("account_id", { count: "exact", head: true }),
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

  // Keyed by account so a rate can be named alongside the account it belongs to
  // rather than as a floating number.
  const accountLabels = new Map(
    rows.map((a) => [a.id as string, `${a.name} ‥${a.mask ?? "????"}`])
  );

  const range = await historyRange(supabase);
  void liabilities;

  return {
    as_of: new Date().toISOString().slice(0, 10),
    // The snapshot below is the last 90 days only. The full book is reachable
    // through the tools, and the model is told its span so it never guesses at
    // how far back the data goes.
    full_history_available_via_tools: range,
    // Labels and balances only. Rates, statement balances, due dates, subtypes
    // and ownership all come from `list_accounts` on demand — carrying them
    // here cost 4,200 tokens on every single turn to answer a question that is
    // asked on maybe one turn in ten.
    accounts: rows.map((a) => ({
      label: `${a.name} ‥${a.mask ?? "????"}`,
      type: a.type,
      balance: a.current_balance,
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
    // The next few only. The rest is a query, not context.
    recurring_next: (recurring ?? [])
      .filter((x) => x.next_expected_date)
      .sort((a, b) => String(a.next_expected_date).localeCompare(String(b.next_expected_date)))
      .slice(0, 8)
      .map((x) => ({
        merchant: x.merchant,
        amount: x.expected_amount,
        due: x.next_expected_date,
        status: x.status,
      })),
    recurring_total: (recurring ?? []).length,
  };
}

const SYSTEM = `You are the conversational side of a self-hosted personal finance platform with exactly one user, its owner. They are asking about their own money.

- A snapshot of their finances is provided as JSON. Answer from it. If the snapshot does not contain what was asked, say so plainly rather than estimating — "that isn't in what I can see" is a good answer.
- Refer to an account by its exact \`label\`. Never pair an account name with a last-four yourself: several accounts share a name and differ only by mask.
- Positive transaction amounts are outflows; negative are inflows.
- \`last_statement_balance\` is what must be paid to avoid interest; the account's balance in \`accounts\` includes charges made since the statement closed and is not yet owed. Never treat the two as interchangeable, and never say interest is accruing on a card whose statement balance was paid.
- Interest rates, statement balances and due dates come from \`list_accounts\`, which lists every rate a card carries rather than one. \`rate_being_paid_pct\` is the one that applies now — a promotional rate overrides the purchase rate while it lasts. Where rates are "not reported by the institution", say the rate is unknown; never treat a missing rate as zero.
- \`floors\` are limits the owner set on their own balance sheet, not suggestions. Never advise anything that would breach one, and never describe a floor's headroom as spare money without saying what it is holding back.
- You are advisory. You cannot move money, place trades or change settings; if asked to, say what you would do and where in the app to do it.
- The snapshot covers the last 90 days. The **full history** is available through your tools — \`list_accounts\` for every account and how to name one, \`search_transactions\` for individual transactions over any period, \`spending_summary\` for totals grouped by category, merchant, month or account. Use them rather than answering "I can only see 90 days", and rather than adding figures up by hand.
- To filter by a specific card, pass its last four digits as \`account\` — several accounts share a name and differ only by the mask, so the digits are the only exact identifier.
- Transfers are excluded from spending by default, because moving money between the owner's own accounts is the same dollar twice. Include them only when the question is about the movement itself, and say when you have.
- Be direct and brief. This is a conversation, not a report — no preamble, no restating the question.`;

export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const incoming = Array.isArray(body?.attachments) ? body.attachments : [];
  // A file on its own is a perfectly good question ("what is this?"), so an
  // empty message is only an error when nothing came with it.
  if (!message && !incoming.length) {
    return NextResponse.json({ error: "message or attachment required" }, { status: 400 });
  }

  // Validated before anything is stored or sent. An oversized or unsupported
  // file should fail here with a reason, not as a provider error the owner
  // cannot map back to the thing they dragged in.
  const attachments: LlmAttachment[] = [];
  for (const a of incoming as { name?: string; media_type?: string; data?: string }[]) {
    const mediaType = String(a.media_type ?? "");
    if (!ATTACHMENT_TYPES.includes(mediaType)) {
      return NextResponse.json(
        { error: `${a.name ?? "file"}: ${mediaType || "unknown type"} is not supported — images or PDF only` },
        { status: 400 }
      );
    }
    // Base64 with newlines is rejected by the API, and every encoder that
    // writes to a file wraps by default. Stripped here rather than trusted.
    const data = String(a.data ?? "").replace(/\s/g, "");
    const bytes = Math.floor((data.length * 3) / 4);
    if (!data) {
      return NextResponse.json({ error: `${a.name ?? "file"}: empty` }, { status: 400 });
    }
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `${a.name ?? "file"} is ${(bytes / 1048576).toFixed(1)} MB — the limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB` },
        { status: 400 }
      );
    }
    attachments.push({
      kind: IMAGE_TYPES.includes(mediaType) ? "image" : "pdf",
      media_type: mediaType,
      data,
      name: a.name,
    });
  }

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

  const { data: userMsg } = await supabase
    .from("conversation_messages")
    .insert({ conversation_id: conversationId, role: "user", content: message })
    .select("id")
    .single();

  // Bytes to Storage, metadata to Postgres. Kept rather than discarded after
  // the call so a thread can be reopened months later and still show what was
  // actually asked about — and so a follow-up question has the file to work
  // from instead of only the model's memory of it.
  for (const a of attachments) {
    const path = `${conversationId}/${crypto.randomUUID()}-${(a.name ?? "file").replace(/[^\w.-]/g, "_")}`;
    const { error: upErr } = await supabase.storage
      .from("chat-attachments")
      .upload(path, Buffer.from(a.data, "base64"), { contentType: a.media_type });
    if (upErr) {
      console.error(`[chat] attachment upload failed: ${upErr.message}`);
      continue;
    }
    await supabase.from("conversation_attachments").insert({
      message_id: userMsg?.id ?? null,
      conversation_id: conversationId,
      kind: a.kind,
      media_type: a.media_type,
      name: a.name ?? null,
      bytes: Math.floor((a.data.length * 3) / 4),
      storage_path: path,
    });
  }

  const context = await buildContext(supabase);
  const turns: ChatTurn[] = [
    ...((history ?? []) as ChatTurn[]),
    { role: "user", content: message || "(see the attached file)", attachments },
  ];

  const result = await chat(
    settings,
    `${SYSTEM}\n\nSnapshot:\n${JSON.stringify(context)}`,
    turns,
    // The same authenticated client the route uses, so every tool query runs
    // under the owner's RLS rather than with elevated rights.
    { db: supabase }
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
    effort: settings.effort ?? null,
    thinking: settings.thinking ?? null,
    tokens: result.tokens,
    attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })),
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

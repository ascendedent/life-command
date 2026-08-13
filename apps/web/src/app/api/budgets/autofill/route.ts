import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";
import { fetchAll, planBudgetLines } from "@finance/shared";

// Creates (or refills) a month's budget from trailing 6-month category
// averages (spec §1.6 Monarch parity). Also computes rollover_in for
// rollover-flagged categories from the prior month's remainder.

export async function POST(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => ({}));
  const month: string = body.month; // "YYYY-MM-01"
  if (!/^\d{4}-\d{2}-01$/.test(month ?? "")) {
    return NextResponse.json({ error: "month must be YYYY-MM-01" }, { status: 400 });
  }

  const monthStart = new Date(`${month}T00:00:00Z`);
  const historyStart = new Date(monthStart);
  historyStart.setUTCMonth(historyStart.getUTCMonth() - 6);

  const [{ data: cats }, { data: txns }] = await Promise.all([
    supabase
      .from("categories")
      .select("id, is_rollover, exclude_from_budget, is_active, category_groups (type)")
      .eq("is_active", true),
    // Paged: six months of history is well past the 1,000-row response cap, and
    // an auto-filled budget built from a truncated history is quietly low.
    fetchAll<{ category_id: string | null; amount: number; date: string }>(() =>
      supabase
        .from("transactions")
        .select("category_id, amount, date, id")
        .gte("date", historyStart.toISOString().slice(0, 10))
        .lt("date", month)
        .eq("hidden", false)  // splits: parent is hidden, children counted
        .order("date")
        .order("id")
    ).then((data) => ({ data })),
  ]);

  const budgetable = (cats ?? []).filter((c) => {
    const g = c.category_groups as unknown as { type: string } | null;
    return g && g.type !== "transfer" && !c.exclude_from_budget;
  });
  const catType = new Map(
    budgetable.map((c) => [
      c.id,
      (c.category_groups as unknown as { type: string }).type,
    ])
  );

  const { data: budget, error: bErr } = await supabase
    .from("budgets")
    .upsert({ month, style: body.style ?? "category" }, { onConflict: "month" })
    .select("id")
    .single();
  if (bErr || !budget) {
    return NextResponse.json({ error: bErr?.message }, { status: 500 });
  }

  // rollover: prior month's (budget + rollover_in - spent), floored at 0
  const prevMonth = new Date(monthStart);
  prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
  const prevKey = prevMonth.toISOString().slice(0, 8) + "01";
  const { data: prevBudget } = await supabase
    .from("budgets")
    .select("id, budget_lines (category_id, amount, rollover_in)")
    .eq("month", prevKey)
    .maybeSingle();
  const prevSpend = new Map<string, number>();
  if (prevBudget) {
    const { data: prevTxns } = await supabase
      .from("transactions")
      .select("category_id, amount")
      .gte("date", prevKey)
      .lt("date", month)
      .eq("hidden", false);  // splits: parent is hidden, children counted
    for (const t of prevTxns ?? []) {
      if (t.category_id && Number(t.amount) > 0) {
        prevSpend.set(t.category_id, (prevSpend.get(t.category_id) ?? 0) + Number(t.amount));
      }
    }
  }

  await supabase.from("budget_lines").delete().eq("budget_id", budget.id);
  const lines = planBudgetLines({
    categories: budgetable.map((c) => ({
      id: c.id,
      is_rollover: c.is_rollover,
      type: catType.get(c.id) ?? "expense",
    })),
    history: (txns ?? []).map((t) => ({ category_id: t.category_id, amount: Number(t.amount) })),
    priorLines:
      (prevBudget?.budget_lines as
        | { category_id: string | null; amount: number; rollover_in: number }[]
        | null) ?? null,
    priorSpend: prevSpend,
  }).map((l) => ({ ...l, budget_id: budget.id }));
  const { error: lErr } = await supabase.from("budget_lines").insert(lines);
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });

  await supabase.from("audit_log").insert({
    actor: "user",
    action: "budget_autofilled",
    entity: "budgets",
    entity_id: budget.id,
    detail: { month, lines: lines.length },
  });

  return NextResponse.json({ budget_id: budget.id, lines: lines.length });
}

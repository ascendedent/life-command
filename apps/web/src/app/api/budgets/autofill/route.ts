import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";

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
    supabase
      .from("transactions")
      .select("category_id, amount, date")
      .gte("date", historyStart.toISOString().slice(0, 10))
      .lt("date", month)
      .eq("hidden", false),  // splits: parent is hidden, children counted
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

  // trailing average of actuals per category (outflows for expense, inflows for income)
  const sums = new Map<string, number>();
  for (const t of txns ?? []) {
    if (!t.category_id || !catType.has(t.category_id)) continue;
    const type = catType.get(t.category_id)!;
    const amt = Number(t.amount);
    const contrib = type === "income" ? -amt : amt; // plaid: inflow negative
    if (contrib > 0) sums.set(t.category_id, (sums.get(t.category_id) ?? 0) + contrib);
  }

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
  const lines = budgetable.map((c) => {
    const avg = Math.round(((sums.get(c.id) ?? 0) / 6) * 100) / 100;
    let rolloverIn = 0;
    if (c.is_rollover && prevBudget) {
      const prevLine = (prevBudget.budget_lines as { category_id: string | null; amount: number; rollover_in: number }[] | null)
        ?.find((l) => l.category_id === c.id);
      if (prevLine) {
        rolloverIn = Math.max(
          0,
          Number(prevLine.amount) + Number(prevLine.rollover_in) - (prevSpend.get(c.id) ?? 0)
        );
      }
    }
    return {
      budget_id: budget.id,
      category_id: c.id,
      amount: avg,
      rollover_in: Math.round(rolloverIn * 100) / 100,
    };
  });
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

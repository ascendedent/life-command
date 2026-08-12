"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CategoryTransactions } from "@/components/budget/category-transactions";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import {
  attributionFrom,
  attributionMonthOf,
  incomeWindowFor,
  isShiftableIncome,
  CALENDAR_ATTRIBUTION,
} from "@finance/shared/src/pay-period";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Line {
  id: string;
  category_id: string | null;
  flex_bucket: string | null;
  amount: number;
  rollover_in: number;
}
interface Cat {
  id: string;
  name: string;
  emoji: string | null;
  is_rollover: boolean;
  group_name: string;
  group_type: string;
  group_sort: number;
  sort_order: number;
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;

export default function BudgetPage() {
  const supabase = useMemo(() => createClient(), []);
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [budgetId, setBudgetId] = useState<string | null>(null);
  const [style, setStyle] = useState<"category" | "flex">("category");
  const [lines, setLines] = useState<Line[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [spent, setSpent] = useState<Map<string, number>>(new Map());
  const [income, setIncome] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [attribution, setAttribution] = useState(CALENDAR_ATTRIBUTION);
  // Which budget line the owner opened to see what it is made of.
  const [drillCat, setDrillCat] = useState<{ id: string; name: string; spent: number } | null>(null);

  // The rows the page needs: the calendar month for spending, widened to cover
  // wherever this month's income may have landed.
  const { queryFrom, queryTo } = useMemo(() => {
    const key = month.slice(0, 7);
    const w = incomeWindowFor(key, attribution);
    const [y, m] = key.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      queryFrom: w.from < month ? w.from : month,
      queryTo: w.to > `${key}-${lastDay}` ? w.to : `${key}-${String(lastDay).padStart(2, "0")}`,
    };
  }, [month, attribution]);

  const nextMonth = useMemo(() => {
    const d = new Date(`${month}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return monthKey(d);
  }, [month]);

  const load = useCallback(async () => {
    setLoaded(false);
    const [{ data: catRows }, { data: budget }, { data: txns }, { data: settingsRow }] =
      await Promise.all([
      supabase
        .from("categories")
        .select(
          "id, name, emoji, is_rollover, exclude_from_budget, sort_order, category_groups (name, type, sort_order)"
        )
        .eq("is_active", true),
      supabase
        .from("budgets")
        .select("id, style, budget_lines (id, category_id, flex_bucket, amount, rollover_in)")
        .eq("month", month)
        .maybeSingle(),
      supabase
        .from("transactions")
        .select("category_id, amount, date")
        // Widened to cover the income window, which under forward_shift reaches
        // into the tail of last month and stops before the tail of this one.
        // Each row is then attributed individually below.
        .gte("date", queryFrom)
        .lte("date", queryTo)
        // hidden=false is the whole story: splitting hides the parent and
        // creates children, so this counts each dollar exactly once. Filtering
        // on parent_transaction_id as well would drop every split.
        .eq("hidden", false),
      supabase
        .from("app_settings")
        .select("income_attribution, income_shift_from_day")
        .eq("id", 1)
        .maybeSingle(),
    ]);

    setCats(
      (catRows ?? [])
        .filter((c) => {
          const g = c.category_groups as unknown as { type: string } | null;
          return g && g.type !== "transfer" && !c.exclude_from_budget;
        })
        .map((c) => {
          const g = c.category_groups as unknown as {
            name: string; type: string; sort_order: number;
          };
          return {
            id: c.id, name: c.name, emoji: c.emoji, is_rollover: c.is_rollover,
            group_name: g.name, group_type: g.type, group_sort: g.sort_order,
            sort_order: c.sort_order,
          };
        })
    );
    setBudgetId(budget?.id ?? null);
    setStyle((budget?.style as "category" | "flex") ?? "category");
    setLines((budget?.budget_lines ?? []) as Line[]);

    // Expenses belong to the month they happened in. Income belongs to the
    // month it is meant to cover, which for a month-end paycheque is the next
    // one — see attributionMonthOf.
    const cfg = attributionFrom(settingsRow ?? null);
    // Refunds and interest keep their calendar month even under forward_shift.
    const catName = new Map((catRows ?? []).map((c: any) => [c.id as string, c.name as string]));
    const s = new Map<string, number>();
    const inc = new Map<string, number>();
    for (const t of txns ?? []) {
      if (!t.category_id) continue;
      const amt = Number(t.amount);
      const date = String(t.date);
      if (amt > 0) {
        if (date >= month && date < nextMonth) {
          s.set(t.category_id, (s.get(t.category_id) ?? 0) + amt);
        }
      } else if (
        attributionMonthOf(date, isShiftableIncome(catName.get(t.category_id)), cfg) ===
        month.slice(0, 7)
      ) {
        inc.set(t.category_id, (inc.get(t.category_id) ?? 0) - amt);
      }
    }
    setAttribution(cfg);
    setSpent(s);
    setIncome(inc);
    setLoaded(true);
  }, [supabase, month, nextMonth, queryFrom, queryTo]);

  useEffect(() => {
    load();
  }, [load]);

  async function autofill() {
    setBusy(true);
    await fetch("/api/budgets/autofill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    });
    setBusy(false);
    load();
  }

  async function saveAmount(line: Line, amount: number) {
    await supabase.from("budget_lines").update({ amount }).eq("id", line.id);
    setLines(lines.map((l) => (l.id === line.id ? { ...l, amount } : l)));
  }

  async function switchStyle(next: "category" | "flex") {
    if (!budgetId) return;
    await supabase.from("budgets").update({ style: next }).eq("id", budgetId);
    if (next === "flex" && !lines.some((l) => l.flex_bucket)) {
      const buckets = ["fixed", "flexible", "non_monthly"].map((b) => ({
        budget_id: budgetId,
        flex_bucket: b,
        amount: 0,
      }));
      await supabase.from("budget_lines").insert(buckets);
    }
    load();
  }

  const lineByCat = new Map(lines.filter((l) => l.category_id).map((l) => [l.category_id!, l]));
  const expenseCats = cats.filter((c) => c.group_type === "expense");
  const incomeCats = cats.filter((c) => c.group_type === "income");

  const totalBudgetedExpense = expenseCats.reduce(
    (s, c) => s + Number(lineByCat.get(c.id)?.amount ?? 0) + Number(lineByCat.get(c.id)?.rollover_in ?? 0),
    0
  );
  const totalBudgetedIncome = incomeCats.reduce(
    (s, c) => s + Number(lineByCat.get(c.id)?.amount ?? 0),
    0
  );
  const totalSpent = [...spent.values()].reduce((a, b) => a + b, 0);
  const totalIncome = [...income.values()].reduce((a, b) => a + b, 0);
  const leftToSpend = totalBudgetedIncome - totalBudgetedExpense;

  const dayOfMonth = new Date().getUTCDate();
  const daysInMonth = new Date(
    new Date(`${month}T00:00:00Z`).getUTCFullYear(),
    new Date(`${month}T00:00:00Z`).getUTCMonth() + 1,
    0
  ).getDate();
  const monthElapsed =
    month === monthKey(new Date()) ? dayOfMonth / daysInMonth : 1;

  const flexLines = lines.filter((l) => l.flex_bucket);
  const fixedBudget = Number(flexLines.find((l) => l.flex_bucket === "fixed")?.amount ?? 0);
  const flexibleBudget = Number(flexLines.find((l) => l.flex_bucket === "flexible")?.amount ?? 0);
  const flexibleRemaining = flexibleBudget - Math.max(0, totalSpent - fixedBudget);

  const groups = [...new Map(expenseCats.map((c) => [c.group_name, c.group_sort])).entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);

  function monthNav(delta: number) {
    const d = new Date(`${month}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    setMonth(monthKey(d));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Budget</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => monthNav(-1)}>←</Button>
          <span className="w-28 text-center font-mono text-sm">
            {new Date(`${month}T00:00:00Z`).toLocaleDateString("en-US", {
              month: "long", year: "numeric", timeZone: "UTC",
            })}
          </span>
          <Button variant="outline" size="sm" onClick={() => monthNav(1)}>→</Button>
          {budgetId && (
            <>
              <div className="ml-2 flex rounded-md border">
                {(["category", "flex"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => switchStyle(s)}
                    className={cn(
                      "px-2.5 py-1 text-xs capitalize",
                      style === s ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={autofill} disabled={busy}>
                Recalculate
              </Button>
            </>
          )}
        </div>
      </div>

      {loaded && !budgetId && (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <p className="text-sm text-muted-foreground">
              No budget for this month yet. Auto-fill seeds every category from
              its trailing 6-month average — every line stays hand-editable.
            </p>
            <Button onClick={autofill} disabled={busy}>
              {busy ? "Computing…" : "Auto-fill from 6-month averages"}
            </Button>
          </CardContent>
        </Card>
      )}

      {budgetId && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Card><CardHeader><CardTitle>Left to spend</CardTitle></CardHeader>
              <CardContent>
                <p className={cn("font-mono text-xl", leftToSpend < 0 && "text-destructive")}>
                  {fmt(leftToSpend)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">income − expense budget</p>
              </CardContent>
            </Card>
            <Card><CardHeader><CardTitle>Spent</CardTitle></CardHeader>
              <CardContent>
                <p className="font-mono text-xl">{fmt(totalSpent)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  of {fmt(totalBudgetedExpense)} budgeted
                </p>
              </CardContent>
            </Card>
            <Card><CardHeader><CardTitle>Income</CardTitle></CardHeader>
              <CardContent>
                <p className="font-mono text-xl">{fmt(totalIncome)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  of {fmt(totalBudgetedIncome)} expected
                </p>
              </CardContent>
            </Card>
            {style === "flex" && (
              <Card><CardHeader><CardTitle>Flexible remaining</CardTitle></CardHeader>
                <CardContent>
                  <p className={cn("font-mono text-xl", flexibleRemaining < 0 && "text-destructive")}>
                    {fmt(flexibleRemaining)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">the one number to watch</p>
                </CardContent>
              </Card>
            )}
          </div>

          {style === "flex" ? (
            <Card>
              <CardHeader><CardTitle>Flex buckets</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {(["fixed", "flexible", "non_monthly"] as const).map((bucket) => {
                  const line = flexLines.find((l) => l.flex_bucket === bucket);
                  if (!line) return null;
                  return (
                    <div key={bucket} className="flex items-center gap-3">
                      <span className="w-28 text-sm capitalize">{bucket.replace("_", "-")}</span>
                      <AmountInput line={line} onSave={saveAmount} />
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  v1 approximation: flexible remaining = flexible budget − (total
                  spend − fixed budget). Category mode is the full-fidelity view.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {groups.map((groupName) => {
                const groupCats = expenseCats
                  .filter((c) => c.group_name === groupName)
                  .sort((a, b) => a.sort_order - b.sort_order);
                const gBudget = groupCats.reduce(
                  (s, c) =>
                    s + Number(lineByCat.get(c.id)?.amount ?? 0) +
                    Number(lineByCat.get(c.id)?.rollover_in ?? 0),
                  0
                );
                const gSpent = groupCats.reduce((s, c) => s + (spent.get(c.id) ?? 0), 0);
                if (gBudget === 0 && gSpent === 0) return null;
                return (
                  <Card key={groupName}>
                    <CardHeader className="flex-row items-center justify-between space-y-0">
                      <CardTitle>{groupName}</CardTitle>
                      <span className="font-mono text-xs text-muted-foreground">
                        {fmt(gSpent)} / {fmt(gBudget)}
                      </span>
                    </CardHeader>
                    <CardContent className="space-y-1.5">
                      {groupCats.map((c) => {
                        const line = lineByCat.get(c.id);
                        const budgeted = Number(line?.amount ?? 0) + Number(line?.rollover_in ?? 0);
                        const catSpent = spent.get(c.id) ?? 0;
                        if (budgeted === 0 && catSpent === 0) return null;
                        const pct = budgeted > 0 ? Math.min(1, catSpent / budgeted) : catSpent > 0 ? 1 : 0;
                        const over = catSpent > budgeted && budgeted > 0;
                        return (
                          <div key={c.id} className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                setDrillCat({ id: c.id, name: `${c.emoji ?? ""} ${c.name}`.trim(), spent: catSpent })
                              }
                              title="Show the transactions behind this figure"
                              className="w-44 truncate text-left text-sm underline-offset-4 hover:underline"
                            >
                              {c.emoji} {c.name}
                              {Number(line?.rollover_in ?? 0) > 0 && (
                                <Badge variant="secondary" className="ml-1.5">
                                  +{fmt(Number(line!.rollover_in))} carried
                                </Badge>
                              )}
                            </button>
                            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn("h-full rounded-full", over ? "bg-destructive" : "bg-primary/70")}
                                style={{ width: `${pct * 100}%` }}
                              />
                              <div
                                className="absolute top-0 h-full w-px bg-foreground/40"
                                style={{ left: `${monthElapsed * 100}%` }}
                                title="month elapsed"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setDrillCat({ id: c.id, name: `${c.emoji ?? ""} ${c.name}`.trim(), spent: catSpent })
                              }
                              title="Show the transactions behind this figure"
                              className={cn(
                                "w-20 text-right font-mono text-xs underline-offset-4 hover:underline",
                                over && "text-destructive"
                              )}
                            >
                              {fmt(catSpent)}
                            </button>
                            {line ? (
                              <AmountInput line={line} onSave={saveAmount} />
                            ) : (
                              <span className="w-24 text-right font-mono text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                );
              })}

              <Card>
                <CardHeader><CardTitle>Income</CardTitle></CardHeader>
                <CardContent className="space-y-1.5">
                  {incomeCats.map((c) => {
                    const line = lineByCat.get(c.id);
                    const got = income.get(c.id) ?? 0;
                    if (!line?.amount && got === 0) return null;
                    return (
                      <div key={c.id} className="flex items-center gap-3">
                        <span className="w-44 truncate text-sm">{c.emoji} {c.name}</span>
                        <span className="flex-1 text-right font-mono text-xs text-primary">
                          {fmt(got)}
                        </span>
                        {line && <AmountInput line={line} onSave={saveAmount} />}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}

      {drillCat && (
        <CategoryTransactions
          categoryId={drillCat.id}
          categoryName={drillCat.name}
          monthStart={month}
          monthEnd={nextMonth}
          expected={drillCat.spent}
          onClose={() => setDrillCat(null)}
        />
      )}
    </div>
  );
}

function AmountInput({ line, onSave }: { line: Line; onSave: (l: Line, n: number) => void }) {
  const [val, setVal] = useState(String(line.amount));
  useEffect(() => setVal(String(line.amount)), [line.amount]);
  return (
    <input
      type="number"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        const n = Number(val);
        if (!Number.isNaN(n) && n !== Number(line.amount)) onSave(line, n);
      }}
      className="h-7 w-24 rounded border border-input bg-transparent px-2 text-right font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

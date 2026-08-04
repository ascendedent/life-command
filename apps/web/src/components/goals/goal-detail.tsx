"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";
// deep imports: the shared index pulls in node-only modules (crypto, plaid)
import { netEfficiency, pace, type GoalLink, type GoalRow } from "@finance/shared/src/goals";
import { fmtMoney } from "@finance/shared/src/reports";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WizardRefs } from "@/components/goals/goal-wizard";

export interface ContributionRow {
  id: string;
  goal_id: string;
  transaction_id: string | null;
  amount: number;
  occurred_at: string;
  source: string;
  via: string | null;
}

export interface CostRow {
  id: string;
  goal_id: string;
  period_start: string | null;
  period_end: string | null;
  cost_type: string;
  amount: number;
  contributing_txn_ids: string[];
  computation: Record<string, unknown> | null;
  narrative: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  ahead: "text-primary",
  on_pace: "text-foreground",
  behind: "text-warning",
  no_target: "text-muted-foreground",
};

const STATUS_LABEL: Record<string, string> = {
  ahead: "ahead of pace",
  on_pace: "on pace",
  behind: "behind pace",
  no_target: "no target date",
};

export function GoalDetail({
  goal,
  links,
  contributions,
  costs,
  refs,
  onChanged,
}: {
  goal: GoalRow;
  links: GoalLink[];
  contributions: ContributionRow[];
  costs: CostRow[];
  refs: WizardRefs;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [expandedCost, setExpandedCost] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const matches = useMemo(
    () =>
      contributions.map((c) => ({
        transaction_id: c.transaction_id ?? c.id,
        date: c.occurred_at.slice(0, 10),
        amount: Number(c.amount),
        merchant: c.via ?? (c.source === "manual" ? "manual entry" : "contribution"),
        via: c.via ?? c.source,
        entity_type: "category" as const,
        entity_id: "",
      })),
    [contributions]
  );

  const p = useMemo(() => pace(goal, matches), [goal, matches]);
  const eff = useMemo(
    () => netEfficiency(p.contributed, costs.map((c) => Number(c.amount))),
    [p.contributed, costs]
  );

  const pct = goal.target_amount ? Math.min(100, (Number(goal.current_amount) / Number(goal.target_amount)) * 100) : 0;
  const expectedPct =
    goal.target_amount && p.expectedByNow != null
      ? Math.min(100, (p.expectedByNow / Number(goal.target_amount)) * 100)
      : null;

  const runSearch = useCallback(async () => {
    if (!search.trim()) return setCandidates([]);
    const { data } = await supabase
      .from("transactions")
      .select("id, date, amount, merchant, merchant_clean")
      .or(`merchant.ilike.%${search.trim()}%,merchant_clean.ilike.%${search.trim()}%`)
      .eq("hidden", false)
      .order("date", { ascending: false })
      .limit(15);
    setCandidates(data ?? []);
  }, [search, supabase]);

  useEffect(() => {
    const t = setTimeout(runSearch, 250);
    return () => clearTimeout(t);
  }, [runSearch]);

  const attach = async (txn: any) => {
    setBusy(true);
    await supabase.from("goal_contributions").insert({
      goal_id: goal.id,
      transaction_id: txn.id,
      amount: Math.abs(Number(txn.amount)),
      occurred_at: `${txn.date}T12:00:00Z`,
      source: "manual",
      via: `manual: ${txn.merchant_clean || txn.merchant || "transaction"}`,
    });
    await supabase.from("sync_jobs").insert({ type: "goal_match", requested_by: "user" });
    setBusy(false);
    setAttachOpen(false);
    setSearch("");
    onChanged();
  };

  const detach = async (id: string) => {
    await supabase.from("goal_contributions").delete().eq("id", id);
    await supabase.from("sync_jobs").insert({ type: "goal_match", requested_by: "user" });
    onChanged();
  };

  const linkLabel = (l: GoalLink) => {
    switch (l.entity_type) {
      case "account":
        return refs.accounts.find((a) => a.id === l.entity_id)?.name ?? "account";
      case "category":
        return refs.categories.find((c) => c.id === l.entity_id)?.name ?? "category";
      case "tag":
        return refs.tags.find((t) => t.id === l.entity_id)?.name ?? "tag";
      case "liability":
        return refs.liabilities.find((x) => x.id === l.entity_id)?.account_name ?? "liability";
      default:
        return refs.recurring.find((r) => r.id === l.entity_id)?.merchant ?? "recurring item";
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            {goal.name}
            <Badge variant="secondary" className="text-[10px]">
              {goal.type.replace(/_/g, " ")}
            </Badge>
            <span className={cn("ml-auto text-xs font-normal", STATUS_STYLE[p.status])}>
              {STATUS_LABEL[p.status]}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="flex items-baseline justify-between">
              <p className="font-mono text-2xl">
                {fmtMoney(Number(goal.current_amount))}
                {goal.target_amount != null && (
                  <span className="ml-1.5 text-sm text-muted-foreground">
                    of {fmtMoney(Number(goal.target_amount))}
                  </span>
                )}
              </p>
              {goal.target_date && (
                <p className="text-xs text-muted-foreground">
                  by {goal.target_date}
                  {p.monthsRemaining != null && ` · ${p.monthsRemaining} months left`}
                </p>
              )}
            </div>
            <div className="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              {expectedPct != null && (
                <div
                  className="absolute top-0 h-full w-px bg-foreground/60"
                  style={{ left: `${expectedPct}%` }}
                  title={`expected by now: ${fmtMoney(p.expectedByNow ?? 0)}`}
                />
              )}
            </div>
            {p.expectedByNow != null && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                marker = {fmtMoney(p.expectedByNow)} expected by today at a straight line to the target date
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: "Contributed (tracked)", value: fmtMoney(p.contributed) },
              {
                label: "Needed per month",
                value: p.requiredPerMonth != null ? fmtMoney(p.requiredPerMonth) : "—",
              },
              {
                label: "Observed per month",
                value: p.observedPerMonth != null ? fmtMoney(p.observedPerMonth) : "—",
              },
              { label: "Projected finish", value: p.projectedDate ?? "—" },
            ].map((s) => (
              <div key={s.label} className="rounded-md border p-2.5">
                <p className="text-[11px] text-muted-foreground">{s.label}</p>
                <p className="mt-0.5 font-mono text-sm">{s.value}</p>
              </div>
            ))}
          </div>

          {p.cadenceExpected != null && (
            <p className="text-xs text-muted-foreground">
              This period: {fmtMoney(p.cadenceActual ?? 0)} of {fmtMoney(p.cadenceExpected)}{" "}
              {goal.cadence === "weekly" ? "weekly" : "monthly"} cadence.
            </p>
          )}

          <div className="rounded-md border border-border bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">Net efficiency</p>
            <p className="mt-1 text-sm">
              Contributed <span className="font-mono text-primary">{fmtMoney(eff.contributed)}</span>, cost{" "}
              <span className="font-mono text-destructive">{fmtMoney(eff.cost)}</span>, net progress{" "}
              <span className="font-mono">{fmtMoney(eff.net)}</span>
              {eff.costRatio != null && eff.cost > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  — {(eff.costRatio * 100).toFixed(1)}¢ of cost per dollar kept
                </span>
              )}
              .
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>Contributions</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setAttachOpen((v) => !v)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Attach
            </Button>
          </CardHeader>
          <CardContent className="px-0">
            {attachOpen && (
              <div className="border-b px-3 pb-2">
                <Input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search transactions by merchant…"
                  className="h-7 text-xs"
                />
                <div className="mt-1 max-h-40 overflow-y-auto">
                  {candidates.map((t) => (
                    <button
                      key={t.id}
                      disabled={busy}
                      onClick={() => attach(t)}
                      className="flex w-full items-center gap-2 py-1 text-left text-xs hover:text-primary"
                    >
                      <span className="w-20 font-mono text-muted-foreground">{t.date}</span>
                      <span className="flex-1 truncate">{t.merchant_clean || t.merchant}</span>
                      <span className="font-mono">{fmtMoney(Math.abs(Number(t.amount)), { cents: true })}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="max-h-72 divide-y divide-border overflow-y-auto">
              {contributions.map((c) => (
                <div key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="w-20 shrink-0 font-mono text-muted-foreground">
                    {c.occurred_at.slice(0, 10)}
                  </span>
                  <span className="flex-1 truncate">{c.via ?? "contribution"}</span>
                  {c.source === "manual" && (
                    <Badge variant="secondary" className="text-[10px]">
                      manual
                    </Badge>
                  )}
                  <span className="w-20 text-right font-mono">{fmtMoney(Number(c.amount), { cents: true })}</span>
                  <button
                    onClick={() => detach(c.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove contribution"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {!contributions.length && (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  Nothing matched yet. The nightly matcher fills this in from the links below.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>True cost</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <div className="divide-y divide-border">
                {costs.map((c) => (
                  <div key={c.id}>
                    <button
                      onClick={() => setExpandedCost((id) => (id === c.id ? null : c.id))}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/40"
                    >
                      <span className="w-20 shrink-0 font-mono text-muted-foreground">
                        {c.period_start?.slice(0, 7) ?? "—"}
                      </span>
                      <span className="flex-1 truncate">{c.cost_type.replace(/_/g, " ")}</span>
                      <span className="font-mono text-destructive">
                        {fmtMoney(Number(c.amount), { cents: true })}
                      </span>
                    </button>
                    {expandedCost === c.id && (
                      <div className="space-y-1 bg-muted/20 px-3 py-2 text-[11px]">
                        {c.narrative && <p className="text-muted-foreground">{c.narrative}</p>}
                        {c.computation && (
                          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-muted-foreground">
                            {JSON.stringify(c.computation, null, 2)}
                          </pre>
                        )}
                        <p className="text-muted-foreground">
                          {c.contributing_txn_ids?.length ?? 0} contributing transactions
                        </p>
                      </div>
                    )}
                  </div>
                ))}
                {!costs.length && (
                  <p className="px-3 py-4 text-xs text-muted-foreground">
                    No costs attributed yet — the recap engine writes these each period from the linked
                    cost drivers.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Linked data</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <div className="divide-y divide-border">
                {links.map((l) => (
                  <div key={l.id ?? `${l.role}${l.entity_id}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{linkLabel(l)}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {l.role.replace(/_/g, " ")}
                    </Badge>
                  </div>
                ))}
                {!links.length && (
                  <p className="px-3 py-4 text-xs text-muted-foreground">
                    No links — edit the goal to connect accounts, categories and cost drivers.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

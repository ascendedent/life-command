"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Target, Trash2 } from "lucide-react";
// deep imports: the shared index pulls in node-only modules (crypto, plaid)
import { pace, type GoalLink, type GoalRow } from "@finance/shared/src/goals";
import { fmtMoney } from "@finance/shared/src/reports";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { GoalWizard, type WizardRefs } from "@/components/goals/goal-wizard";
import {
  GoalDetail,
  type ContributionRow,
  type CostRow,
} from "@/components/goals/goal-detail";

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  ahead: { label: "ahead", className: "bg-primary/15 text-primary" },
  on_pace: { label: "on pace", className: "bg-secondary text-secondary-foreground" },
  behind: { label: "behind", className: "bg-warning/15 text-warning" },
  no_target: { label: "no target", className: "bg-muted text-muted-foreground" },
};

export default function GoalsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [links, setLinks] = useState<GoalLink[]>([]);
  const [contributions, setContributions] = useState<ContributionRow[]>([]);
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [refs, setRefs] = useState<WizardRefs>({
    accounts: [],
    categories: [],
    tags: [],
    liabilities: [],
    recurring: [],
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [wizard, setWizard] = useState<null | { goal: GoalRow; links: GoalLink[] } | "new">(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [
      { data: goalRows },
      { data: linkRows },
      { data: contribRows },
      { data: costRows },
      { data: acctRows },
      { data: catRows },
      { data: tagRows },
      { data: liabRows },
      { data: recRows },
    ] = await Promise.all([
      supabase.from("goals").select("*").order("priority").order("created_at"),
      supabase.from("goal_links").select("*"),
      supabase.from("goal_contributions").select("*").order("occurred_at", { ascending: false }),
      supabase.from("goal_costs").select("*").order("period_start", { ascending: false }),
      supabase.from("accounts").select("id, name, type, mask").order("name"),
      supabase
        .from("categories")
        .select("id, name, category_groups (name, type)")
        .eq("is_active", true)
        .order("sort_order"),
      supabase.from("tags").select("id, name").order("name"),
      supabase.from("liabilities").select("id, account_id, type, apr, balance, accounts (name)"),
      supabase.from("recurring_items").select("id, merchant, expected_amount, cadence").neq("status", "cancelled"),
    ]);

    setGoals((goalRows ?? []) as GoalRow[]);
    setLinks((linkRows ?? []) as GoalLink[]);
    setContributions((contribRows ?? []) as ContributionRow[]);
    setCosts((costRows ?? []) as CostRow[]);
    setRefs({
      accounts: (acctRows ?? []) as WizardRefs["accounts"],
      categories: (catRows ?? []).map((c: any) => ({
        id: c.id,
        name: c.name,
        group_name: c.category_groups?.name ?? "",
        group_type: c.category_groups?.type ?? "expense",
      })),
      tags: (tagRows ?? []) as WizardRefs["tags"],
      liabilities: (liabRows ?? []).map((l: any) => ({
        id: l.id,
        account_id: l.account_id,
        type: l.type,
        apr: l.apr,
        balance: l.balance,
        account_name: l.accounts?.name ?? "account",
      })),
      recurring: (recRows ?? []) as WizardRefs["recurring"],
    });
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const linksFor = useCallback((goalId: string) => links.filter((l) => l.goal_id === goalId), [links]);

  const remove = async (goal: GoalRow) => {
    if (!confirm(`Delete "${goal.name}"? Its links and contribution history go with it.`)) return;
    await supabase.from("goals").delete().eq("id", goal.id);
    if (selected === goal.id) setSelected(null);
    load();
  };

  const active = goals.find((g) => g.id === selected) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium">Goals</h1>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Button size="sm" className="ml-auto" onClick={() => setWizard("new")}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New goal
        </Button>
      </div>

      {!goals.length && !loading ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Target className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm">No goals yet.</p>
            <p className="max-w-md text-xs text-muted-foreground">
              A goal is more than a number: the wizard links it to the accounts, categories and cost
              drivers it touches, which is what lets the recap say what hitting it actually cost you.
            </p>
            <Button size="sm" className="mt-2" onClick={() => setWizard("new")}>
              Create the first one
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {goals.map((g) => {
            const gContribs = contributions.filter((c) => c.goal_id === g.id);
            const p = pace(
              g,
              gContribs.map((c) => ({
                transaction_id: c.transaction_id ?? c.id,
                date: c.occurred_at.slice(0, 10),
                amount: Number(c.amount),
                merchant: "",
                via: c.via ?? c.source,
                entity_type: "category" as const,
                entity_id: "",
              }))
            );
            const pct = g.target_amount
              ? Math.min(100, (Number(g.current_amount) / Number(g.target_amount)) * 100)
              : 0;
            const badge = STATUS_BADGE[p.status];
            const isOpen = selected === g.id;

            return (
              <Card key={g.id} className={cn(isOpen && "border-primary/40")}>
                <CardContent className="py-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setSelected(isOpen ? null : g.id)}
                      className="flex flex-1 items-center gap-3 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm">{g.name}</span>
                          <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]", badge.className)}>
                            {badge.label}
                          </span>
                          {linksFor(g.id).length === 0 && (
                            <Badge variant="warning" className="text-[10px]">
                              unlinked
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="w-40 shrink-0 text-right">
                        <p className="font-mono text-sm">
                          {fmtMoney(Number(g.current_amount))}
                          {g.target_amount != null && (
                            <span className="text-muted-foreground"> / {fmtMoney(Number(g.target_amount))}</span>
                          )}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {g.target_date ? `by ${g.target_date}` : g.cadence_amount ? `${fmtMoney(Number(g.cadence_amount))}/${g.cadence}` : "no deadline"}
                        </p>
                      </div>
                    </button>
                    <button
                      onClick={() => setWizard({ goal: g, links: linksFor(g.id) })}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Edit ${g.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => remove(g)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${g.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {active && (
        <GoalDetail
          goal={active}
          links={linksFor(active.id)}
          contributions={contributions.filter((c) => c.goal_id === active.id)}
          costs={costs.filter((c) => c.goal_id === active.id)}
          refs={refs}
          onChanged={load}
        />
      )}

      {wizard && (
        <GoalWizard
          refs={refs}
          existing={wizard === "new" ? null : wizard}
          onClose={() => setWizard(null)}
          onSaved={() => {
            setWizard(null);
            load();
          }}
        />
      )}
    </div>
  );
}

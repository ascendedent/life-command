"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
// deep imports: the shared index pulls in node-only modules (crypto, plaid)
import {
  GOAL_TYPES,
  dedupeMatches,
  interestAccrued,
  matchContributions,
  netEfficiency,
  type ContributionMatch,
  type GoalLink,
  type GoalType,
} from "@finance/shared/src/goals";
import { fmtMoney, type ReportTxn } from "@finance/shared/src/reports";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface WizardRefs {
  accounts: { id: string; name: string; type: string; mask: string | null }[];
  categories: { id: string; name: string; group_name: string; group_type: string }[];
  tags: { id: string; name: string }[];
  liabilities: { id: string; account_id: string; type: string | null; apr: number | null; balance: number | null; account_name: string }[];
  recurring: { id: string; merchant: string; expected_amount: number | null; cadence: string | null }[];
}

interface Draft {
  name: string;
  type: GoalType;
  target_amount: string;
  target_date: string;
  cadence_amount: string;
  cadence: string;
  priority: string;
  funding_account_id: string | null;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  type: "savings_target",
  target_amount: "",
  target_date: "",
  cadence_amount: "",
  cadence: "monthly",
  priority: "1",
  funding_account_id: null,
};

const key = (l: GoalLink) => `${l.role}:${l.entity_type}:${l.entity_id}`;

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-foreground"
          : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function GoalWizard({
  refs,
  existing,
  onClose,
  onSaved,
}: {
  refs: WizardRefs;
  existing?: { goal: any; links: GoalLink[] } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() =>
    existing
      ? {
          name: existing.goal.name ?? "",
          type: existing.goal.type ?? "savings_target",
          target_amount: existing.goal.target_amount != null ? String(existing.goal.target_amount) : "",
          target_date: existing.goal.target_date ?? "",
          cadence_amount: existing.goal.cadence_amount != null ? String(existing.goal.cadence_amount) : "",
          cadence: existing.goal.cadence ?? "monthly",
          priority: String(existing.goal.priority ?? 1),
          funding_account_id: existing.goal.funding_account_id ?? null,
        }
      : EMPTY_DRAFT
  );
  const [links, setLinks] = useState<GoalLink[]>(existing?.links ?? []);
  const [history, setHistory] = useState<ReportTxn[]>([]);
  const [tagsByTxn, setTagsByTxn] = useState<Map<string, Set<string>>>(new Map());
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleLink = (link: GoalLink) =>
    setLinks((prev) =>
      prev.some((l) => key(l) === key(link)) ? prev.filter((l) => key(l) !== key(link)) : [...prev, link]
    );
  const has = (link: GoalLink) => links.some((l) => key(l) === key(link));

  // Preview needs real history — six months is enough to show whether the
  // linkage catches anything without making the query heavy.
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    (async () => {
      setLoadingPreview(true);
      const from = new Date();
      from.setUTCMonth(from.getUTCMonth() - 6);
      const { data } = await supabase
        .from("transactions")
        .select("id, date, amount, merchant, merchant_clean, category_id, account_id, transaction_tags (tag_id)")
        .gte("date", from.toISOString().slice(0, 10))
        .eq("hidden", false)
        .order("date", { ascending: false })
        .limit(4000);
      if (cancelled) return;
      const tagMap = new Map<string, Set<string>>();
      const rows: ReportTxn[] = (data ?? []).map((t: any) => {
        const links = (t.transaction_tags ?? []) as { tag_id: string }[];
        if (links.length) tagMap.set(t.id, new Set(links.map((l) => l.tag_id)));
        return { ...t, amount: Number(t.amount) };
      });
      setHistory(rows);
      setTagsByTxn(tagMap);
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [step, supabase]);

  const ctx = useMemo(
    () => ({
      tagsByTxn,
      categoryNames: new Map(refs.categories.map((c) => [c.id, c.name])),
      accountNames: new Map(refs.accounts.map((a) => [a.id, a.name])),
      tagNames: new Map(refs.tags.map((t) => [t.id, t.name])),
    }),
    [tagsByTxn, refs]
  );

  const preview = useMemo(() => {
    const raw = matchContributions(history, links, ctx);
    const matches = dedupeMatches(raw);
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const mk = lastMonth.toISOString().slice(0, 7);
    const lastMonthMatches = matches.filter((m) => m.date.startsWith(mk));
    const contributed = lastMonthMatches.reduce((s, m) => s + m.amount, 0);

    const days = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0)).getUTCDate();
    const costs = links
      .filter((l) => l.role === "cost_driver" && l.entity_type === "liability")
      .map((l) => {
        const liab = refs.liabilities.find((x) => x.id === l.entity_id);
        if (!liab?.balance || !liab.apr) return null;
        return { name: liab.account_name, ...interestAccrued(Number(liab.balance), Number(liab.apr), days) };
      })
      .filter(Boolean) as ({ name: string } & ReturnType<typeof interestAccrued>)[];

    const recurringCosts = links
      .filter((l) => l.role === "cost_driver" && l.entity_type === "recurring_item")
      .map((l) => refs.recurring.find((r) => r.id === l.entity_id))
      .filter(Boolean)
      .map((r) => ({ name: r!.merchant, interest: Number(r!.expected_amount ?? 0), formula: `recurring ${r!.cadence ?? ""} charge` }));

    const allCosts = [...costs, ...recurringCosts];
    return {
      matches,
      collapsed: raw.length - matches.length,
      lastMonthKey: mk,
      lastMonthMatches,
      contributed,
      costs: allCosts,
      efficiency: netEfficiency(contributed, allCosts.map((c) => c.interest)),
    };
  }, [history, links, ctx, refs]);

  const canAdvance =
    step === 0
      ? draft.name.trim().length > 0 &&
        (draft.target_amount.trim() !== "" || draft.cadence_amount.trim() !== "")
      : true;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        type: draft.type,
        target_amount: draft.target_amount ? Number(draft.target_amount) : null,
        target_date: draft.target_date || null,
        cadence_amount: draft.cadence_amount ? Number(draft.cadence_amount) : null,
        cadence: draft.cadence_amount ? draft.cadence : null,
        priority: Number(draft.priority) || 1,
        funding_account_id: draft.funding_account_id,
      };

      let goalId = existing?.goal?.id as string | undefined;
      if (goalId) {
        const { error: upErr } = await supabase.from("goals").update(payload).eq("id", goalId);
        if (upErr) throw upErr;
        const { error: delErr } = await supabase.from("goal_links").delete().eq("goal_id", goalId);
        if (delErr) throw delErr;
      } else {
        const { data, error: insErr } = await supabase.from("goals").insert(payload).select("id").single();
        if (insErr) throw insErr;
        goalId = data!.id as string;
      }

      if (links.length) {
        const { error: linkErr } = await supabase.from("goal_links").insert(
          links.map((l) => ({
            goal_id: goalId,
            entity_type: l.entity_type,
            entity_id: l.entity_id,
            role: l.role,
            notes: l.notes ?? null,
          }))
        );
        if (linkErr) throw linkErr;
      }

      // Ask the worker to re-match history against the new linkage.
      await supabase.from("sync_jobs").insert({ type: "goal_match", requested_by: "user" });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const STEPS = ["Define", "Link data", "Preview"];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur-sm">
      <div className="my-8 w-full max-w-3xl rounded-lg border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <h2 className="text-sm font-medium">{existing ? "Edit goal" : "New goal"}</h2>
          <div className="ml-auto flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs",
                  i === step
                    ? "bg-accent text-accent-foreground"
                    : i < step
                      ? "text-primary"
                      : "text-muted-foreground"
                )}
              >
                {i < step ? "✓ " : ""}
                {s}
              </span>
            ))}
          </div>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          {step === 0 && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="Six months of expenses"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label>Type</Label>
                <div className="flex flex-wrap gap-1.5">
                  {GOAL_TYPES.map((t) => (
                    <Chip key={t.value} active={draft.type === t.value} onClick={() => setDraft((d) => ({ ...d, type: t.value }))}>
                      {t.label}
                    </Chip>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {GOAL_TYPES.find((t) => t.value === draft.type)?.hint}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Target amount</Label>
                  <Input
                    type="number"
                    value={draft.target_amount}
                    onChange={(e) => setDraft((d) => ({ ...d, target_amount: e.target.value }))}
                    placeholder="18000"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Target date</Label>
                  <Input
                    type="date"
                    value={draft.target_date}
                    onChange={(e) => setDraft((d) => ({ ...d, target_date: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Or a cadence</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      value={draft.cadence_amount}
                      onChange={(e) => setDraft((d) => ({ ...d, cadence_amount: e.target.value }))}
                      placeholder="800"
                    />
                    <select
                      value={draft.cadence}
                      onChange={(e) => setDraft((d) => ({ ...d, cadence: e.target.value }))}
                      className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="monthly">per month</option>
                      <option value="weekly">per week</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Priority</Label>
                  <Input
                    type="number"
                    min={1}
                    value={draft.priority}
                    onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                A target with a date drives pace math; a cadence judges each month on its own. Setting
                both is fine — the target wins for pace, the cadence for the monthly check.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                These links are what the recap engine uses to attribute contributions and costs. Nothing
                here changes your transactions.
              </p>

              <div className="space-y-1.5">
                <Label>Funding account — where this goal&apos;s money lives</Label>
                <div className="flex flex-wrap gap-1.5">
                  {refs.accounts.map((a) => (
                    <Chip
                      key={a.id}
                      active={has({ entity_type: "account", entity_id: a.id, role: "funding" })}
                      onClick={() => {
                        toggleLink({ entity_type: "account", entity_id: a.id, role: "funding" });
                        setDraft((d) => ({
                          ...d,
                          funding_account_id: d.funding_account_id === a.id ? null : a.id,
                        }));
                      }}
                    >
                      {a.name}
                      {a.mask ? ` ••${a.mask}` : ""}
                    </Chip>
                  ))}
                  {!refs.accounts.length && (
                    <p className="text-xs text-muted-foreground">No accounts linked yet.</p>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Money arriving in a funding account counts as a contribution.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Counts as a contribution — categories</Label>
                <div className="flex flex-wrap gap-1.5">
                  {refs.categories
                    .filter((c) => c.group_type !== "income")
                    .map((c) => (
                      <Chip
                        key={c.id}
                        active={has({ entity_type: "category", entity_id: c.id, role: "contribution_source" })}
                        onClick={() => toggleLink({ entity_type: "category", entity_id: c.id, role: "contribution_source" })}
                      >
                        {c.name}
                      </Chip>
                    ))}
                </div>
              </div>

              {refs.tags.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Counts as a contribution — tags</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {refs.tags.map((t) => (
                      <Chip
                        key={t.id}
                        active={has({ entity_type: "tag", entity_id: t.id, role: "contribution_source" })}
                        onClick={() => toggleLink({ entity_type: "tag", entity_id: t.id, role: "contribution_source" })}
                      >
                        {t.name}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Cost drivers — charged against this goal</Label>
                <div className="flex flex-wrap gap-1.5">
                  {refs.liabilities.map((l) => (
                    <Chip
                      key={l.id}
                      active={has({ entity_type: "liability", entity_id: l.id, role: "cost_driver" })}
                      onClick={() => toggleLink({ entity_type: "liability", entity_id: l.id, role: "cost_driver" })}
                    >
                      {l.account_name}
                      {l.apr ? ` ${Number(l.apr).toFixed(2)}%` : ""}
                    </Chip>
                  ))}
                  {refs.recurring.map((r) => (
                    <Chip
                      key={r.id}
                      active={has({ entity_type: "recurring_item", entity_id: r.id, role: "cost_driver" })}
                      onClick={() => toggleLink({ entity_type: "recurring_item", entity_id: r.id, role: "cost_driver" })}
                    >
                      {r.merchant}
                      {r.expected_amount ? ` ${fmtMoney(Number(r.expected_amount))}` : ""}
                    </Chip>
                  ))}
                  {!refs.liabilities.length && !refs.recurring.length && (
                    <p className="text-xs text-muted-foreground">
                      No liabilities or recurring items detected yet.
                    </p>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Interest carried on a linked card while you fund this goal is what makes the recap&apos;s
                  &ldquo;what it truly cost&rdquo; line honest.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Constraints — don&apos;t raid these to fund it</Label>
                <div className="flex flex-wrap gap-1.5">
                  {refs.accounts.map((a) => (
                    <Chip
                      key={a.id}
                      active={has({ entity_type: "account", entity_id: a.id, role: "constraint" })}
                      onClick={() => toggleLink({ entity_type: "account", entity_id: a.id, role: "constraint" })}
                    >
                      {a.name}
                    </Chip>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {loadingPreview ? (
                <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Replaying six months of history…
                </p>
              ) : (
                <>
                  <div>
                    <p className="text-sm">
                      What last month&apos;s recap would have said for{" "}
                      <span className="text-foreground">{draft.name || "this goal"}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Period {preview.lastMonthKey} · linkage replayed against real transactions
                    </p>
                  </div>

                  {!links.length && (
                    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      No links yet — the goal will save, but nothing will auto-match and the recap can&apos;t
                      attribute costs to it. Go back and link at least one contribution source.
                    </div>
                  )}

                  {links.length > 0 && !preview.matches.length && (
                    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      These links caught nothing in six months of history. Either the linkage is wrong or
                      there are no transactions yet — worth checking before you rely on it.
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Contributed</p>
                      <p className="mt-1 font-mono text-xl text-primary">{fmtMoney(preview.contributed)}</p>
                      <p className="text-[11px] text-muted-foreground">{preview.lastMonthMatches.length} transactions</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">What it cost</p>
                      <p className="mt-1 font-mono text-xl text-destructive">
                        {fmtMoney(preview.efficiency.cost)}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{preview.costs.length} cost drivers</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Net progress</p>
                      <p className="mt-1 font-mono text-xl">{fmtMoney(preview.efficiency.net)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {preview.efficiency.costRatio != null
                          ? `${(preview.efficiency.costRatio * 100).toFixed(1)}¢ cost per $1 saved`
                          : "—"}
                      </p>
                    </div>
                  </div>

                  {preview.costs.length > 0 && (
                    <div className="rounded-md border">
                      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">Cost math</p>
                      {preview.costs.map((c, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                          <span className="w-32 shrink-0 truncate">{c.name}</span>
                          <span className="flex-1 truncate font-mono text-muted-foreground">{c.formula}</span>
                          <span className="font-mono">{fmtMoney(c.interest, { cents: true })}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="rounded-md border">
                    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
                      <span className="flex-1">Matched contributions (6 months)</span>
                      {preview.collapsed > 0 && <span>{preview.collapsed} duplicate legs collapsed</span>}
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      {preview.matches.slice(0, 60).map((m: ContributionMatch) => (
                        <div key={m.transaction_id} className="flex items-center gap-2 px-3 py-1 text-xs">
                          <span className="w-20 shrink-0 font-mono text-muted-foreground">{m.date}</span>
                          <span className="flex-1 truncate">{m.merchant}</span>
                          <span className="w-40 truncate text-muted-foreground">{m.via}</span>
                          <span className="w-20 text-right font-mono">{fmtMoney(m.amount, { cents: true })}</span>
                        </div>
                      ))}
                      {!preview.matches.length && (
                        <p className="px-3 py-3 text-xs text-muted-foreground">Nothing matched.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                Back
              </Button>
            )}
            {step < 2 ? (
              <Button size="sm" onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
                Next
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                )}
                {existing ? "Save changes" : "Create goal"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Clock, Loader2, Play, X } from "lucide-react";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import { fmtMoney } from "@finance/shared/src/reports";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SERIES, STATUS } from "@/lib/chart-theme";

interface Recap {
  id: string;
  period_type: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  scores: Record<string, number> | null;
  overall_score: number | null;
  goal_cost_summary: GoalCostSummary[] | null;
  adjustments: Adjustment[] | null;
  content_md: string | null;
  created_at: string;
}

interface Adjustment {
  title: string;
  rationale: string;
  projected_monthly_savings: number;
  confidence: number;
}

interface GoalCostSummary {
  goal_id: string;
  goal_name: string;
  contributed: number;
  costs: {
    cost_type: string;
    amount: number;
    narrative: string;
    computation: Record<string, unknown>;
    contributing_txn_ids: string[];
  }[];
  total_cost: number;
  net_efficiency: number;
  cost_per_dollar_pct: number | null;
  pace_status: string;
}

interface SubReview {
  id: string;
  recap_id: string;
  recurring_item_id: string;
  verdict: "keep" | "replace" | "cut" | "watch";
  reasoning: string | null;
  suggested_alternative: string | null;
  projected_monthly_savings: number | null;
  user_decision: string | null;
  recurring_items: { merchant: string; expected_amount: number | null; cadence: string | null } | null;
}

const DOMAINS: { key: string; label: string }[] = [
  { key: "cash_flow", label: "Cash flow" },
  { key: "budget_adherence", label: "Budget" },
  { key: "goal_tradeoffs", label: "Goal tradeoffs" },
  { key: "credit_usage", label: "Credit" },
  { key: "investing", label: "Investing" },
];

const VERDICT_STYLE: Record<string, string> = {
  keep: "text-primary",
  watch: "text-warning",
  replace: "text-warning",
  cut: "text-destructive",
};

const scoreColor = (n: number) =>
  n >= 75 ? STATUS.good : n >= 50 ? STATUS.warning : STATUS.critical;

/** Minimal markdown: headings, bullets, bold, paragraphs. No HTML passthrough. */
function Markdown({ src }: { src: string }) {
  const blocks = src.split(/\n{2,}/);
  const inline = (text: string, keyBase: string) =>
    text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={`${keyBase}-${i}`} className="text-foreground">
          {part.slice(2, -2)}
        </strong>
      ) : (
        <span key={`${keyBase}-${i}`}>{part}</span>
      )
    );

  return (
    <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
      {blocks.map((block, b) => {
        const lines = block.split("\n");
        if (lines[0]?.startsWith("#")) {
          const level = lines[0].match(/^#+/)![0].length;
          const text = lines[0].replace(/^#+\s*/, "");
          return (
            <p key={b} className={cn("text-foreground", level <= 2 ? "text-base font-medium" : "text-sm font-medium")}>
              {inline(text, `h${b}`)}
            </p>
          );
        }
        if (lines.every((l) => /^\s*[-*]\s/.test(l))) {
          return (
            <ul key={b} className="ml-4 list-disc space-y-1">
              {lines.map((l, i) => (
                <li key={i}>{inline(l.replace(/^\s*[-*]\s/, ""), `l${b}-${i}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={b}>{inline(block, `p${b}`)}</p>;
      })}
    </div>
  );
}

export function RecapsTab() {
  const supabase = useMemo(() => createClient(), []);
  const [recaps, setRecaps] = useState<Recap[]>([]);
  const [reviews, setReviews] = useState<SubReview[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expandedCost, setExpandedCost] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failures, setFailures] = useState<{ id: string; started_at: string; error: string | null }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: recapRows }, { data: reviewRows }, { data: failed }] = await Promise.all([
      supabase.from("recaps").select("*").order("period_start", { ascending: false }).limit(24),
      supabase
        .from("subscription_reviews")
        .select("*, recurring_items (merchant, expected_amount, cadence)")
        .order("projected_monthly_savings", { ascending: false }),
      supabase
        .from("agent_runs")
        .select("id, started_at, error")
        .like("trigger", "recap%")
        .eq("status", "failed")
        .order("started_at", { ascending: false })
        .limit(3),
    ]);
    const rows = (recapRows ?? []) as Recap[];
    setRecaps(rows);
    setReviews((reviewRows ?? []) as unknown as SubReview[]);
    setFailures(failed ?? []);
    setSelected((cur) => cur ?? rows[0]?.id ?? null);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const runNow = async (type: "recap_weekly" | "recap_monthly") => {
    setRunning(type);
    const { data: job } = await supabase
      .from("sync_jobs")
      .insert({ type, requested_by: "user" })
      .select("id")
      .single();
    if (!job) return setRunning(null);
    const poll = setInterval(async () => {
      const { data } = await supabase.from("sync_jobs").select("status").eq("id", job.id).single();
      if (data?.status === "done" || data?.status === "error") {
        clearInterval(poll);
        setRunning(null);
        load();
      }
    }, 3000);
  };

  const recap = recaps.find((r) => r.id === selected) ?? null;
  const prior = recap
    ? recaps.find((r) => r.period_type === recap.period_type && r.period_start < recap.period_start)
    : null;

  const acceptAdjustment = async (r: Recap, a: Adjustment, index: number) => {
    const key = `${r.id}:${index}`;
    await supabase.from("recommendations").insert({
      type: "alert",
      summary: a.title,
      rationale: a.rationale,
      payload: null, // advisory in Phase 2 — the executor has nothing to act on
      confidence: a.confidence,
      status: "pending",
      expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "recap_adjustment_accepted",
      entity: "recaps",
      entity_id: r.id,
      detail: { title: a.title, projected_monthly_savings: a.projected_monthly_savings },
    });
    setAccepted((prev) => new Set(prev).add(key));
  };

  const decide = async (review: SubReview, decision: "accepted" | "rejected" | "deferred") => {
    await supabase
      .from("subscription_reviews")
      .update({ user_decision: decision, decided_at: new Date().toISOString() })
      .eq("id", review.id);

    if (decision === "accepted" && review.verdict !== "keep") {
      await supabase.from("recommendations").insert({
        type: "alert",
        summary: `${review.verdict === "cut" ? "Cancel" : review.verdict === "replace" ? "Replace" : "Review"} ${
          review.recurring_items?.merchant ?? "subscription"
        }`,
        rationale: review.reasoning,
        payload: null,
        confidence: 0.8,
        status: "pending",
        expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      });
    }
    load();
  };

  const recapReviews = recap ? reviews.filter((v) => v.recap_id === recap.id) : [];
  const addressable = recapReviews
    .filter((v) => v.user_decision !== "rejected" && v.verdict !== "keep")
    .reduce((s, v) => s + Number(v.projected_monthly_savings ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <div className="flex flex-wrap gap-1">
          {recaps.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={cn(
                "rounded-md px-2 py-1 text-xs transition-colors",
                selected === r.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {r.period_type === "weekly" ? "wk" : "mo"} {r.period_start}
              {r.overall_score != null && (
                <span className="ml-1 font-mono" style={{ color: scoreColor(Number(r.overall_score)) }}>
                  {Math.round(Number(r.overall_score))}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" disabled={!!running} onClick={() => runNow("recap_weekly")}>
            <Play className={cn("mr-1.5 h-3.5 w-3.5", running === "recap_weekly" && "animate-pulse")} />
            Weekly now
          </Button>
          <Button variant="outline" size="sm" disabled={!!running} onClick={() => runNow("recap_monthly")}>
            <Play className={cn("mr-1.5 h-3.5 w-3.5", running === "recap_monthly" && "animate-pulse")} />
            Monthly now
          </Button>
        </div>
      </div>

      {failures.length > 0 && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-1 pt-4">
            <p className="text-sm text-destructive">
              {failures.length} recap {failures.length === 1 ? "run was" : "runs were"} rejected
            </p>
            {failures.map((f) => (
              <p key={f.id} className="font-mono text-[11px] text-muted-foreground">
                {f.started_at.slice(0, 16).replace("T", " ")} — {f.error}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              A recap is discarded whole when it cites a figure the deterministic stage did not
              produce. Nothing partial is ever shown.
            </p>
          </CardContent>
        </Card>
      )}

      {!recap ? (
        !loading && (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-sm">No recaps yet.</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                Weekly recaps run Sunday at 22:00 and monthly ones on the 1st. Run one now to see
                what the current data produces — with no linked bank the numbers will be thin, but
                the pipeline is the same.
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle>
                {recap.period_type === "weekly" ? "Week of" : "Month of"} {recap.period_start}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  through {recap.period_end}
                </span>
              </CardTitle>
              <div className="text-right">
                <span
                  className="font-mono text-2xl"
                  style={{ color: scoreColor(Number(recap.overall_score ?? 0)) }}
                >
                  {Math.round(Number(recap.overall_score ?? 0))}
                </span>
                {prior?.overall_score != null && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {Number(recap.overall_score) >= Number(prior.overall_score) ? "+" : ""}
                    {Math.round(Number(recap.overall_score) - Number(prior.overall_score))} vs prior
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-5">
                {DOMAINS.map((d, i) => {
                  const score = Number(recap.scores?.[d.key] ?? 0);
                  const priorScore = prior?.scores?.[d.key];
                  return (
                    <div key={d.key} className="rounded-md border p-2.5">
                      <p className="text-[11px] text-muted-foreground">{d.label}</p>
                      <p className="mt-0.5 font-mono text-lg" style={{ color: scoreColor(score) }}>
                        {Math.round(score)}
                      </p>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${score}%`, background: SERIES[i] }}
                        />
                      </div>
                      {priorScore != null && (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {Math.round(score - Number(priorScore)) >= 0 ? "+" : ""}
                          {Math.round(score - Number(priorScore))} vs prior
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {recap.content_md && (
            <Card>
              <CardContent className="pt-5">
                <Markdown src={recap.content_md} />
              </CardContent>
            </Card>
          )}

          {!!recap.goal_cost_summary?.length && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>What the goals actually cost</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <div className="divide-y divide-border">
                  {recap.goal_cost_summary.map((g) => (
                    <div key={g.goal_id} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm">{g.goal_name}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {g.pace_status.replace(/_/g, " ")}
                        </Badge>
                        <span className="ml-auto text-sm">
                          Contributed{" "}
                          <span className="font-mono text-primary">{fmtMoney(g.contributed)}</span>, cost{" "}
                          <span className="font-mono text-destructive">{fmtMoney(g.total_cost)}</span>, net{" "}
                          <span className="font-mono">{fmtMoney(g.net_efficiency)}</span>
                        </span>
                      </div>
                      {g.costs.map((c, i) => (
                        <div key={i} className="mt-1.5">
                          <button
                            onClick={() =>
                              setExpandedCost((id) => (id === `${g.goal_id}-${i}` ? null : `${g.goal_id}-${i}`))
                            }
                            className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
                          >
                            <ChevronRight
                              className={cn(
                                "h-3 w-3 transition-transform",
                                expandedCost === `${g.goal_id}-${i}` && "rotate-90"
                              )}
                            />
                            {c.narrative}
                          </button>
                          {expandedCost === `${g.goal_id}-${i}` && (
                            <div className="ml-4 mt-1 space-y-1 rounded-md bg-muted/30 p-2 text-[11px]">
                              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-muted-foreground">
                                {JSON.stringify(c.computation, null, 2)}
                              </pre>
                              <p className="text-muted-foreground">
                                {c.contributing_txn_ids.length} contributing transactions:{" "}
                                <span className="font-mono">
                                  {c.contributing_txn_ids.slice(0, 4).join(", ")}
                                  {c.contributing_txn_ids.length > 4 ? " …" : ""}
                                </span>
                              </p>
                            </div>
                          )}
                        </div>
                      ))}
                      {!g.costs.length && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          No attributed costs this period.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {!!recap.adjustments?.length && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Recommended adjustments</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <div className="divide-y divide-border">
                  {recap.adjustments.map((a, i) => {
                    const key = `${recap.id}:${i}`;
                    const done = accepted.has(key);
                    return (
                      <div key={i} className="flex flex-wrap items-start gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">{a.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{a.rationale}</p>
                        </div>
                        {a.projected_monthly_savings > 0 && (
                          <Badge variant="default" className="shrink-0">
                            {fmtMoney(a.projected_monthly_savings)}/mo
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          variant={done ? "ghost" : "outline"}
                          disabled={done}
                          onClick={() => acceptAdjustment(recap, a, i)}
                        >
                          <Check className="mr-1.5 h-3.5 w-3.5" />
                          {done ? "In queue" : "Accept"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {recap.period_type === "monthly" && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle>Subscription review</CardTitle>
                <span className="text-sm">
                  <span className="text-muted-foreground">addressable </span>
                  <span className="font-mono text-primary">{fmtMoney(addressable)}</span>
                  <span className="text-muted-foreground">/mo</span>
                </span>
              </CardHeader>
              <CardContent className="px-0">
                <div className="divide-y divide-border">
                  {recapReviews.map((v) => (
                    <div key={v.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {v.recurring_items?.merchant ?? "subscription"}
                          <span className={cn("ml-2 text-xs", VERDICT_STYLE[v.verdict])}>{v.verdict}</span>
                          {v.recurring_items?.expected_amount != null && (
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {fmtMoney(Number(v.recurring_items.expected_amount))}
                              {v.recurring_items.cadence ? `/${v.recurring_items.cadence}` : ""}
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{v.reasoning}</p>
                        {v.suggested_alternative && (
                          <p className="mt-0.5 text-xs text-primary">→ {v.suggested_alternative}</p>
                        )}
                      </div>
                      {Number(v.projected_monthly_savings ?? 0) > 0 && (
                        <Badge variant="default" className="shrink-0">
                          {fmtMoney(Number(v.projected_monthly_savings))}/mo
                        </Badge>
                      )}
                      {v.user_decision ? (
                        <Badge variant="secondary" className="shrink-0">
                          {v.user_decision}
                        </Badge>
                      ) : (
                        <div className="flex shrink-0 gap-1">
                          <Button size="sm" variant="outline" onClick={() => decide(v, "accepted")}>
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => decide(v, "deferred")}>
                            <Clock className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground"
                            onClick={() => decide(v, "rejected")}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                  {!recapReviews.length && (
                    <p className="px-4 py-4 text-xs text-muted-foreground">
                      No subscriptions reviewed — recurring detection needs a few months of
                      transactions before it has subscriptions to judge.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

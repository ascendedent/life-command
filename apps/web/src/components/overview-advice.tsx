"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Lightbulb, Check, Inbox } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * What to do, on the page you open first.
 *
 * The analysis was reaching two surfaces and neither was the one you land on:
 * concrete adjustments sat in Reports behind a tab, alerts sat in the Approval
 * Queue, and Overview showed a count of pending recommendations and nothing
 * else. The most valuable thing the system produces was the hardest thing to
 * reach, and nothing said a new recap existed.
 *
 * This is the answer surface. Reports keeps the full archive — the narrative,
 * the domain scores, the subscription review — because this is the summary and
 * that is the reading.
 */

interface Adjustment {
  title: string;
  rationale: string;
  projected_monthly_savings: number;
  confidence: number;
}

interface Recap {
  id: string;
  period_type: string;
  period_start: string;
  period_end: string;
  overall_score: number | null;
  adjustments: Adjustment[] | null;
}

interface Rec {
  id: string;
  summary: string;
  rationale: string | null;
  confidence: number | null;
}

const scoreColor = (n: number) =>
  n >= 75 ? "var(--success, #4ade80)" : n >= 50 ? "var(--warning, #fbbf24)" : "var(--destructive, #f87171)";

const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function OverviewAdvice() {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: r }, { data: p }] = await Promise.all([
      supabase
        .from("recaps")
        .select("id, period_type, period_start, period_end, overall_score, adjustments")
        .order("period_end", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("recommendations")
        .select("id, summary, rationale, confidence")
        .eq("status", "pending")
        .order("confidence", { ascending: false })
        .limit(3),
    ]);
    setRecap((r ?? null) as Recap | null);
    setRecs((p ?? []) as Rec[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function accept(a: Adjustment, index: number) {
    if (!recap) return;
    const supabase = createClient();
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
      entity_id: recap.id,
      detail: { title: a.title, projected_monthly_savings: a.projected_monthly_savings, via: "overview" },
    });
    setAccepted((prev) => new Set(prev).add(index));
    load();
  }

  if (!loaded) return null;
  if (!recap && recs.length === 0) return null;

  const adjustments = (recap?.adjustments ?? []).slice(0, 3);
  const score = recap?.overall_score != null ? Math.round(Number(recap.overall_score)) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Lightbulb className="h-3.5 w-3.5" /> What to do
          {score != null && (
            <span className="ml-1 font-mono text-sm" style={{ color: scoreColor(score) }}>
              {score}
            </span>
          )}
          {recap && (
            <span className="text-xs font-normal text-muted-foreground">
              {recap.period_type} recap · {recap.period_start} to {recap.period_end}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {adjustments.length > 0 ? (
          <div className="space-y-2">
            {adjustments.map((a, i) => (
              <div key={i} className="flex items-start gap-3 rounded-md border p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{a.rationale}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.projected_monthly_savings > 0 && (
                    <Badge variant="secondary">{fmt(a.projected_monthly_savings)}/mo</Badge>
                  )}
                  {accepted.has(i) ? (
                    <span className="flex items-center gap-1 text-xs text-primary">
                      <Check className="h-3.5 w-3.5" /> queued
                    </span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => accept(a, i)}>
                      Accept
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          recap && (
            <p className="text-sm text-muted-foreground">
              The last recap found nothing worth changing.
            </p>
          )
        )}

        {recs.length > 0 && (
          <div className="space-y-1.5 border-t pt-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Inbox className="h-3.5 w-3.5" /> {recs.length} awaiting your acknowledgement
            </p>
            {recs.map((r) => (
              <p key={r.id} className="truncate text-sm">
                {r.summary}
              </p>
            ))}
          </div>
        )}

        <div className="flex gap-3 text-xs text-muted-foreground">
          <Link href="/reports" className="underline-offset-4 hover:text-foreground hover:underline">
            Full recap →
          </Link>
          <Link href="/queue" className="underline-offset-4 hover:text-foreground hover:underline">
            Approval queue →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, ChevronDown, ChevronUp } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Rec {
  id: string;
  created_at: string;
  type: string;
  summary: string;
  rationale: string | null;
  confidence: number | null;
  status: string;
  expires_at: string | null;
  reviewed_at: string | null;
}

function daysLeft(iso: string | null): string {
  if (!iso) return "";
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  return `expires in ${days}d`;
}

export default function QueuePage() {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [recs, setRecs] = useState<Rec[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    let q = supabase.from("recommendations").select("*").order("created_at", { ascending: false });
    if (tab === "pending") q = q.eq("status", "pending");
    else q = q.neq("status", "pending").limit(100);
    const { data } = await q;
    setRecs((data ?? []) as Rec[]);
  }, [supabase, tab]);

  useEffect(() => {
    load();
  }, [load]);

  async function resolve(rec: Rec, status: "approved" | "rejected") {
    await supabase
      .from("recommendations")
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq("id", rec.id);
    await supabase.from("audit_log").insert({
      actor: "user",
      action: status === "approved" ? "recommendation_acknowledged" : "recommendation_dismissed",
      entity: "recommendations",
      entity_id: rec.id,
      detail: { summary: rec.summary },
    });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Approval Queue</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Advisory mode — the agent analyzes and alerts; nothing executes.
            Execution arrives in Phase 3, always behind your approval.
          </p>
        </div>
        <div className="flex rounded-md border">
          {(["pending", "history"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-1 text-xs capitalize",
                tab === t ? "bg-accent text-accent-foreground" : "text-muted-foreground"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {recs.map((rec) => {
          const isExpanded = expanded.has(rec.id);
          return (
            <Card key={rec.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-md bg-warning/15 p-1.5 text-warning">
                    {rec.type === "alert" ? (
                      <AlertTriangle className="h-4 w-4" />
                    ) : (
                      <Bot className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{rec.summary}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="secondary">{rec.type}</Badge>
                      {rec.confidence != null && (
                        <span className="font-mono">
                          {(Number(rec.confidence) * 100).toFixed(0)}% confidence
                        </span>
                      )}
                      {rec.status === "pending" ? (
                        <span>{daysLeft(rec.expires_at)}</span>
                      ) : (
                        <Badge variant={rec.status === "approved" ? "default" : "outline"}>
                          {rec.status === "approved" ? "acknowledged" : rec.status}
                        </Badge>
                      )}
                      <span className="font-mono">
                        {new Date(rec.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    {rec.rationale && (
                      <>
                        <button
                          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            const next = new Set(expanded);
                            if (isExpanded) next.delete(rec.id);
                            else next.add(rec.id);
                            setExpanded(next);
                          }}
                        >
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                          rationale
                        </button>
                        {isExpanded && (
                          <p className="mt-1.5 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
                            {rec.rationale}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {rec.status === "pending" && (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" onClick={() => resolve(rec, "approved")}>
                        Acknowledge
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        onClick={() => resolve(rec, "rejected")}
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {recs.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {tab === "pending"
              ? "Queue is clear — the agent runs daily at 06:00, or trigger one from the Agent page."
              : "No history yet."}
          </p>
        )}
      </div>
    </div>
  );
}

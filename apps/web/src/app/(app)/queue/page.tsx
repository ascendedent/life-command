"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, ChevronDown, ChevronUp, TrendingDown, TrendingUp } from "lucide-react";
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
  payload: TradePayload | null;
  result: { violations?: string[]; problems?: string[]; error?: string } | null;
}

interface TradePayload {
  symbol?: string;
  side?: "buy" | "sell";
  notional?: number | null;
  qty?: number | null;
  limit_price?: number | null;
  time_in_force?: string;
  amount?: number;
  price_used?: number | null;
  mode?: string;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * What approving this actually does. An alert is filed; a trade is placed. The
 * button has to say which, because the same click means two different things
 * and only one of them spends money.
 */
function ProposedOrder({ p }: { p: TradePayload }) {
  const size =
    p.notional != null
      ? money(p.notional)
      : `${p.qty} ${p.qty === 1 ? "share" : "shares"}`;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-2.5 text-xs">
      <span className="font-medium uppercase">
        {p.side} {p.symbol}
      </span>
      <span className="font-mono">{size}</span>
      <span className="font-mono text-muted-foreground">
        {p.limit_price != null ? `limit ${money(p.limit_price)}` : "market"}
        {" \u00b7 "}
        {p.time_in_force === "gtc" ? "good till cancelled" : "day"}
      </span>
      {p.amount != null && p.notional == null && (
        <span className="text-muted-foreground">
          {"\u2248 "}
          {money(p.amount)}
          {p.price_used != null && ` at ${money(p.price_used)}/share when proposed`}
        </span>
      )}
      {p.mode && (
        <Badge variant={p.mode === "live" ? "default" : "outline"}>{p.mode}</Badge>
      )}
    </div>
  );
}

function daysLeft(iso: string | null): string {
  if (!iso) return "";
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  return `expires in ${days}d`;
}

/**
 * Why an approved trade did not go through. The executor records this, and it
 * is the only place the owner can see that their own limits refused it — a
 * status of "failed" on its own reads like a broker outage.
 */
function refusalReasons(rec: Rec): string[] {
  return rec.result?.violations ?? rec.result?.problems ?? (rec.result?.error ? [rec.result.error] : []);
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
    // An acknowledged alert and an approved trade are different events, and the
    // audit log is where the difference has to be legible a year from now.
    const executable = rec.type === "trade";
    await supabase.from("audit_log").insert({
      actor: "user",
      action:
        status === "approved"
          ? executable
            ? "recommendation_approved"
            : "recommendation_acknowledged"
          : executable
            ? "recommendation_rejected"
            : "recommendation_dismissed",
      entity: "recommendations",
      entity_id: rec.id,
      detail: { summary: rec.summary, type: rec.type, payload: rec.payload },
    });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Approval Queue</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The agent proposes; you decide. Acknowledging an alert files it and
            nothing else happens. Approving a trade places it, and the limits you
            set are re-checked in code at that moment — approval alone does not
            override them.
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
                  <div
                    className={cn(
                      "mt-0.5 rounded-md p-1.5",
                      rec.type === "trade"
                        ? "bg-primary/15 text-primary"
                        : "bg-warning/15 text-warning"
                    )}
                  >
                    {rec.type === "alert" ? (
                      <AlertTriangle className="h-4 w-4" />
                    ) : rec.type === "trade" ? (
                      rec.payload?.side === "sell" ? (
                        <TrendingDown className="h-4 w-4" />
                      ) : (
                        <TrendingUp className="h-4 w-4" />
                      )
                    ) : (
                      <Bot className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{rec.summary}</p>
                    {rec.type === "trade" && rec.payload && <ProposedOrder p={rec.payload} />}
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
                    {rec.status === "failed" && refusalReasons(rec).length > 0 && (
                      <ul className="mt-2 space-y-0.5 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-muted-foreground">
                        {refusalReasons(rec).map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {rec.status === "pending" && (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" onClick={() => resolve(rec, "approved")}>
                        {rec.type === "trade" ? "Approve" : "Acknowledge"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        onClick={() => resolve(rec, "rejected")}
                      >
                        {rec.type === "trade" ? "Reject" : "Dismiss"}
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

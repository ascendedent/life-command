"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Play, ShieldAlert, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useActiveJobs } from "@/lib/use-active-jobs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ExecutionReadiness } from "@/components/agent/execution-readiness";
import { cn } from "@/lib/utils";

const LEVELS = [
  { level: 0, name: "Read-only", desc: "Analysis and alerts only. Nothing else." },
  { level: 1, name: "Recommend", desc: "Structured recommendations queue for your review. Still nothing executes." },
  { level: 2, name: "Approve-to-execute", desc: "The agent proposes trades and an approved one executes, re-checked against the guardrails at that moment." },
  { level: 3, name: "Bounded autonomy", desc: "Allow-listed types under caps auto-execute on the agent sub-account. (Phase 4)" },
];

interface AgentConfig {
  autonomy_level: number;
  max_txn_amount: number;
  max_daily_amount: number;
  max_open_positions: number;
  max_position_size: number;
  drawdown_halt_pct: number;
}

interface Run {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string | null;
  model: string | null;
  tokens_used: number | null;
  status: string;
  error: string | null;
}

export default function AgentPage() {
  const supabase = useMemo(() => createClient(), []);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [breakers, setBreakers] = useState<{ id: string; at: string; rule: string }[]>([]);
  // The readiness card reads the same row the autonomy buttons write, so it has
  // to be told when one of them changes rather than discovering it on reload.
  const [configVersion, setConfigVersion] = useState(0);
  // In-flight state belongs to the worker, not to this page — read it from
  // the job queue so it survives navigation and is shared with every tab.
  const { isRunning, refresh: refreshJobs } = useActiveJobs();
  const running = isRunning("agent_run");
  const enriching = isRunning("enrich");

  const load = useCallback(async () => {
    const [{ data: cfg }, { data: runRows }, { data: cb }] = await Promise.all([
      supabase.from("agent_config").select("*").eq("id", 1).maybeSingle(),
      supabase.from("agent_runs").select("*").order("started_at", { ascending: false }).limit(20),
      supabase.from("circuit_breaker_events").select("id, at, rule").order("at", { ascending: false }).limit(10),
    ]);
    setConfig(cfg as AgentConfig | null);
    setRuns((runRows ?? []) as Run[]);
    setBreakers(cb ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // The runs table and recommendations are stale the moment a job finishes.
  // The old code refreshed them from the per-click poller; now that the poller
  // is shared, refresh on the transition out of "busy" instead.
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = running || enriching;
    if (wasBusy.current && !busy) load();
    wasBusy.current = busy;
  }, [running, enriching, load]);

  async function setLevel(level: number) {
    await supabase.from("agent_config").update({ autonomy_level: level }).eq("id", 1);
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "autonomy_level_changed",
      entity: "agent_config",
      detail: { level },
    });
    setConfigVersion((v) => v + 1);
    load();
  }

  async function saveGuardrail(field: keyof AgentConfig, value: number) {
    await supabase.from("agent_config").update({ [field]: value }).eq("id", 1);
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "guardrail_changed",
      entity: "agent_config",
      detail: { [field]: value },
    });
    setConfigVersion((v) => v + 1);
    load();
  }

  /**
   * Queue the job and stop caring what happens next.
   *
   * The worker owns the work; this page only reports it. The previous version
   * held the in-flight flag in React state and polled with a setInterval, so
   * navigating away discarded both — the run continued in the worker while the
   * UI forgot it existed, and coming back showed an idle button.
   */
  async function queueJob(type: "agent_run" | "enrich") {
    await supabase.from("sync_jobs").insert({ type, requested_by: "user" });
    await refreshJobs();
  }

  const runNow = () => queueJob("agent_run");
  const enrichNow = () => queueJob("enrich");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agent</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={enrichNow} disabled={enriching}>
            <Sparkles className={cn("h-4 w-4", enriching && "animate-pulse")} />
            {enriching ? "Enriching…" : "Enrich now"}
          </Button>
          <Button onClick={runNow} disabled={running}>
            <Play className={cn("h-4 w-4", running && "animate-pulse")} />
            {running ? "Analyzing…" : "Run analysis now"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" /> Autonomy level
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {LEVELS.map((l) => {
            // Level 2 is live: the executor and its guardrails exist. Level 3
            // is not — auto-execution needs the circuit breakers first, and
            // offering it before they work would be offering a lie.
            const disabled = l.level >= 3;
            const active = config?.autonomy_level === l.level;
            return (
              <button
                key={l.level}
                disabled={disabled}
                onClick={() => setLevel(l.level)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
                  active && "border-primary bg-primary/5",
                  disabled && "cursor-not-allowed opacity-40"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-xs",
                    active && "border-primary bg-primary text-primary-foreground"
                  )}
                >
                  {l.level}
                </span>
                <span>
                  <span className="text-sm font-medium">
                    {l.name}
                    {disabled && (
                      <Badge variant="secondary" className="ml-2">
                        Phase 4
                      </Badge>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{l.desc}</span>
                </span>
              </button>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5" /> Guardrails
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Enforced in code at the execution layer, never by prompt. The
            executor re-validates these on every action regardless of approval.
          </p>
          {config && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(
                [
                  ["max_txn_amount", "Max per transaction ($)"],
                  ["max_daily_amount", "Max per day ($)"],
                  ["max_open_positions", "Max open positions"],
                  ["max_position_size", "Max position size ($)"],
                  ["drawdown_halt_pct", "Drawdown halt (%)"],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="space-y-1 text-xs text-muted-foreground">
                  {label}
                  <Input
                    type="number"
                    defaultValue={Number(config[field])}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v) && v !== Number(config[field])) {
                        saveGuardrail(field, v);
                      }
                    }}
                    className="h-8 font-mono text-sm"
                  />
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ExecutionReadiness key={configVersion} onChanged={load} />

      <Card>
        <CardHeader>
          <CardTitle>Circuit breakers</CardTitle>
        </CardHeader>
        <CardContent>
          {breakers.length ? (
            breakers.map((b) => (
              <p key={b.id} className="text-sm text-destructive">
                {new Date(b.at).toLocaleString()} — {b.rule}
              </p>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No breaker events. Velocity, drawdown, and failure halts go live
              with execution in Phase 4.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run history</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Started</th>
                  <th className="py-2 pr-4 font-medium">Trigger</th>
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 pr-4 text-right font-medium">Tokens</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {new Date(r.started_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-xs">{r.trigger}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.model}</td>
                    <td className="py-2 pr-4 text-right font-mono text-xs">
                      {r.tokens_used?.toLocaleString() ?? "—"}
                    </td>
                    <td className="py-2">
                      <Badge
                        variant={
                          r.status === "done"
                            ? "default"
                            : r.status === "running"
                              ? "secondary"
                              : "destructive"
                        }
                      >
                        {r.status}
                      </Badge>
                      {r.error && (
                        <span className="ml-2 text-xs text-destructive">{r.error}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                      No runs yet — daily at 06:00, or run one now.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

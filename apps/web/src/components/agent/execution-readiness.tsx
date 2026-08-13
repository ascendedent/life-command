"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleSlash, Loader2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Check {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface Candidate {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  provider: string;
  is_agent_controlled: boolean;
}

interface Status {
  canPropose: boolean;
  canExecute: boolean;
  autonomy_level: number;
  mode: "paper" | "live";
  allowed_action_types: string[];
  checks: Check[];
  broker: {
    status: string;
    cash: number;
    equity: number;
    buying_power: number;
    positions: { symbol: string; qty: number; market_value: number; unrealized_pl: number }[];
  } | null;
  brokerError: string | null;
  candidates: Candidate[];
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Why the agent is not proposing trades.
 *
 * Trading is opt-in at five independent points, and the failure mode of that
 * design is that four-out-of-five looks identical to none-out-of-five: the
 * queue is simply empty and nothing says why. The worker knows the reason and
 * writes it to a log nobody reads. This puts it on the page, next to the switch
 * that would fix it.
 */
export function ExecutionReadiness({ onChanged }: { onChanged?: () => void }) {
  const supabase = createClient();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/execution/status");
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const after = async () => {
    await load();
    onChanged?.();
  };

  async function toggleTradeType() {
    if (!status) return;
    setBusy(true);
    const next = status.allowed_action_types.includes("trade")
      ? status.allowed_action_types.filter((t) => t !== "trade")
      : [...status.allowed_action_types, "trade"];
    await supabase.from("agent_config").update({ allowed_action_types: next }).eq("id", 1);
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "guardrail_changed",
      entity: "agent_config",
      detail: { allowed_action_types: next },
    });
    await after();
    setBusy(false);
  }

  async function setMode(mode: "paper" | "live") {
    setBusy(true);
    await supabase.from("agent_config").update({ execution_mode: mode }).eq("id", 1);
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "execution_mode_changed",
      entity: "agent_config",
      detail: { mode },
    });
    await after();
    setBusy(false);
  }

  async function createBrokerAccount() {
    setBusy(true);
    const res = await fetch("/api/execution/status", { method: "POST" });
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? "could not reach the broker");
    else setError(null);
    await after();
    setBusy(false);
  }

  async function pickAccount(id: string, on: boolean) {
    setBusy(true);
    await fetch(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_agent_controlled: on }),
    });
    await after();
    setBusy(false);
  }

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Execution</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const tradeAllowed = status.allowed_action_types.includes("trade");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-1.5">
          {status.canPropose ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          Execution
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant={status.mode === "live" ? "default" : "outline"}>{status.mode}</Badge>
          <Badge variant={status.canExecute ? "default" : "secondary"}>
            {status.canExecute
              ? "armed"
              : status.canPropose
                ? "proposals only"
                : "off"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Trading is opt-in at five independent points, each checked against the
          world rather than assumed. Four of five being on behaves exactly like
          none of them being on — so every one of them is listed, and the one
          that is off is the reason the queue has no trades in it.
        </p>

        <ul className="space-y-1.5">
          {status.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-xs">
              {c.ok ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className={cn(!c.ok && "text-muted-foreground")}>
                <span className="font-medium">{c.label}</span>
                <span className="block text-muted-foreground">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        {status.brokerError && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-muted-foreground">
            The broker did not answer: {status.brokerError}. An unreachable
            broker is not a verdict on any trade — nothing executes while the
            guardrail inputs are unknown, and it resumes on its own.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button size="sm" variant={tradeAllowed ? "default" : "outline"} disabled={busy} onClick={toggleTradeType}>
            {tradeAllowed ? "Trade allow-listed" : "Allow-list trade"}
          </Button>
          <div className="flex rounded-md border">
            {(["paper", "live"] as const).map((m) => (
              <button
                key={m}
                disabled={busy}
                onClick={() => setMode(m)}
                className={cn(
                  "px-3 py-1 text-xs capitalize",
                  status.mode === m ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                )}
              >
                {m}
              </button>
            ))}
          </div>
          {status.mode === "live" && (
            <span className="text-xs text-destructive">
              Live places real orders. The spec gates this on 30 days of clean paper trading.
            </span>
          )}
        </div>

        <div className="border-t pt-3">
          <p className="mb-2 text-xs font-medium">Agent-controlled account</p>
          {status.candidates.length ? (
            <div className="space-y-1">
              {status.candidates.map((a) => (
                <button
                  key={a.id}
                  disabled={busy}
                  onClick={() => pickAccount(a.id, !a.is_agent_controlled)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md border p-2 text-left text-xs",
                    a.is_agent_controlled && "border-primary bg-primary/5"
                  )}
                >
                  <span>
                    {a.name} {"‥"}
                    {a.mask ?? "????"}
                  </span>
                  {a.is_agent_controlled && <Badge>agent-controlled</Badge>}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No investment account exists yet. Alpaca is not a bank Plaid
              aggregates, so the account orders land in has to be created from
              the broker rather than synced.
            </p>
          )}
          {status.checks.find((c) => c.key === "keys")?.ok && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={busy}
              onClick={createBrokerAccount}
            >
              {status.candidates.some((a) => a.provider === "alpaca")
                ? "Refresh from broker"
                : "Create it from the broker"}
            </Button>
          )}
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>

        {status.broker && (
          <div className="border-t pt-3 text-xs">
            <p className="mb-1.5 font-medium">
              Broker {"·"} {status.broker.status.toLowerCase()}
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-muted-foreground">
              <span>cash {money(status.broker.cash)}</span>
              <span>equity {money(status.broker.equity)}</span>
              <span>buying power {money(status.broker.buying_power)}</span>
              <span>{status.broker.positions.length} positions</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

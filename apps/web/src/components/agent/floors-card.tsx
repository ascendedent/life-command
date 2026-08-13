"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Reading {
  id: string;
  kind: string;
  label: string;
  limit: number;
  projected: number;
  headroom: number;
  ok: boolean;
  evaluable: boolean;
  detail: string;
}

interface Floor {
  id: string;
  kind: string;
  account_id: string | null;
  amount: number | null;
  pct: number | null;
  months: number | null;
  horizon_days: number;
  enabled: boolean;
}

interface Account {
  id: string;
  name: string;
  mask: string | null;
  type: string;
}

interface Payload {
  floors: Floor[];
  readings: Reading[];
  accounts: Account[];
  obligations: { dated: number; total: number };
  monthlyExpenses: number;
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const KINDS = [
  { kind: "liquid_minimum", label: "Liquid never below" },
  { kind: "account_minimum", label: "One account never below" },
  { kind: "credit_utilization_max", label: "Credit utilization never above" },
  { kind: "never_touch", label: "Never draw from" },
] as const;

/**
 * Floors, with live headroom.
 *
 * The number that matters is not the limit, it is the distance to it — a floor
 * shown without its headroom is a setting, and a floor shown with it is a
 * warning. Anything the platform cannot currently measure says so rather than
 * rendering a reassuring zero.
 */
export function FloorsCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/floors");
    if (res.ok) setData(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(kind: string) {
    setBusy(true);
    await fetch("/api/floors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        account_id: draft.account_id || null,
        amount: draft.amount || null,
        pct: draft.pct || null,
        months: draft.months || null,
        horizon_days: draft.horizon_days || 14,
      }),
    });
    setDraft({});
    setAdding(null);
    await load();
    setBusy(false);
  }

  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/floors?id=${id}`, { method: "DELETE" });
    await load();
    setBusy(false);
  }

  if (!data) return null;

  const byId = new Map(data.floors.map((f) => [f.id, f]));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" /> Floors
        </CardTitle>
        {data.readings.length > 0 && (
          <Badge variant={data.readings.every((r) => r.ok) ? "outline" : "default"}>
            {data.readings.filter((r) => r.ok).length}/{data.readings.length} clear
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          The caps above ask whether an action is too big. These ask whether the
          balance sheet it leaves behind is one you agreed to — a limit no single
          transfer can be measured against, because two that are each fine are
          not always fine together. They outrank approval: approving something
          that breaks a floor is you saying &ldquo;I want this&rdquo; while the
          floor is you saying &ldquo;not below here&rdquo;, and the calmer
          instruction wins.
        </p>

        {data.readings.length > 0 && (
          <ul className="space-y-2">
            {data.readings.map((r) => (
              <li key={r.id} className="rounded-md border p-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      {!r.evaluable ? (
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
                      ) : r.ok ? (
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
                      ) : (
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
                      )}
                      {r.label}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.detail}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        "font-mono text-xs",
                        !r.evaluable
                          ? "text-warning"
                          : r.ok
                            ? "text-success"
                            : "text-destructive"
                      )}
                    >
                      {!r.evaluable
                        ? "not measurable"
                        : r.kind === "never_touch"
                          ? r.ok
                            ? "untouched"
                            : "would be drawn on"
                          : r.kind === "credit_utilization_max"
                            ? `${r.projected.toFixed(1)}% of ${r.limit.toFixed(0)}%`
                            : `${money(r.headroom)} above it`}
                    </span>
                    <button
                      onClick={() => remove(r.id)}
                      disabled={busy}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove floor"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {/*
                  A bar only where a distance means something. "Never touch" has
                  no headroom to draw, and drawing an empty one would imply it
                  does.
                */}
                {r.evaluable && r.kind !== "never_touch" && r.limit > 0 && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full", r.ok ? "bg-success" : "bg-destructive")}
                      style={{
                        width: `${Math.min(100, Math.max(2, (r.projected / (r.kind === "credit_utilization_max" ? Math.max(r.limit, r.projected) : Math.max(r.limit * 1.5, r.projected))) * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {data.readings.length === 0 && (
          <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            No floors set. Nothing stops the agent from proposing something that
            empties an account, other than the caps — and a cap cannot see a
            balance.
          </p>
        )}

        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap gap-2">
            {KINDS.filter((k) => !data.floors.some((f) => f.kind === k.kind && !f.account_id) || k.kind === "account_minimum" || k.kind === "never_touch").map((k) => (
              <Button
                key={k.kind}
                size="sm"
                variant={adding === k.kind ? "default" : "outline"}
                onClick={() => {
                  setAdding(adding === k.kind ? null : k.kind);
                  setDraft({});
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {k.label}
              </Button>
            ))}
          </div>

          {adding && (
            <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
              {(adding === "account_minimum" || adding === "never_touch") && (
                <label className="space-y-1 text-xs text-muted-foreground">
                  Account
                  <select
                    className="block h-8 rounded-md border bg-background px-2 text-sm"
                    value={draft.account_id ?? ""}
                    onChange={(e) => setDraft({ ...draft, account_id: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {data.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ‥{a.mask ?? "????"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(adding === "liquid_minimum" || adding === "account_minimum") && (
                <label className="space-y-1 text-xs text-muted-foreground">
                  Dollars
                  <Input
                    type="number"
                    className="h-8 w-32 font-mono text-sm"
                    value={draft.amount ?? ""}
                    onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                  />
                </label>
              )}
              {adding === "liquid_minimum" && (
                <label className="space-y-1 text-xs text-muted-foreground">
                  …or months of expenses
                  <Input
                    type="number"
                    className="h-8 w-32 font-mono text-sm"
                    value={draft.months ?? ""}
                    onChange={(e) => setDraft({ ...draft, months: e.target.value })}
                  />
                </label>
              )}
              {adding === "credit_utilization_max" && (
                <label className="space-y-1 text-xs text-muted-foreground">
                  Percent
                  <Input
                    type="number"
                    className="h-8 w-24 font-mono text-sm"
                    value={draft.pct ?? ""}
                    onChange={(e) => setDraft({ ...draft, pct: e.target.value })}
                  />
                </label>
              )}
              {adding !== "never_touch" && (
                <label className="space-y-1 text-xs text-muted-foreground">
                  Reserve bills due within (days)
                  <Input
                    type="number"
                    className="h-8 w-28 font-mono text-sm"
                    value={draft.horizon_days ?? "14"}
                    onChange={(e) => setDraft({ ...draft, horizon_days: e.target.value })}
                  />
                </label>
              )}
              <Button size="sm" disabled={busy} onClick={() => save(adding)}>
                Set floor
              </Button>
            </div>
          )}

          {adding === "liquid_minimum" && (
            <p className="text-xs text-muted-foreground">
              Months is measured against {money(data.monthlyExpenses)} of average
              monthly spending over the last six months — check that figure looks
              right before relying on it.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Bills due inside the horizon are treated as already spent.{" "}
            {data.obligations.dated} of {data.obligations.total} recurring items
            carry a due date
            {data.obligations.dated < data.obligations.total &&
              " — the rest cannot be reserved for, because nothing knows when they land"}
            .
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

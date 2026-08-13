"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import {
  compareGroups,
  fmtMoney,
  fmtPct,
  monthlySeries,
  summarize,
  type GroupDelta,
} from "@finance/shared/src/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { FLOW, GRID, TEXT_MUTED } from "@/lib/chart-theme";
import { monthLabel, priorPeriod, priorYear, type Period } from "@/lib/periods";
import type { ReportData } from "@/lib/use-report-data";

type Basis = "prior_period" | "prior_year";

const compactMoney = (n: number) =>
  Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1)}k` : `$${n.toFixed(0)}`;

function DeltaTable({ rows, basisLabel }: { rows: GroupDelta[]; basisLabel: string }) {
  if (!rows.length) {
    return <p className="px-3 py-4 text-sm text-muted-foreground">Nothing to compare yet.</p>;
  }
  return (
    <div className="divide-y divide-border">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">Group</span>
        <span className="w-24 text-right">This period</span>
        <span className="w-24 text-right">{basisLabel}</span>
        <span className="w-24 text-right">Change</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 px-3 py-1.5 text-sm">
          <span className="flex-1 truncate">{r.name}</span>
          <span className="w-24 text-right font-mono">{fmtMoney(r.current)}</span>
          <span className="w-24 text-right font-mono text-muted-foreground">{fmtMoney(r.prior)}</span>
          <span
            className={cn(
              "w-24 text-right font-mono text-xs",
              r.delta > 0 ? "text-destructive" : r.delta < 0 ? "text-primary" : "text-muted-foreground"
            )}
          >
            {r.delta > 0 ? "+" : ""}
            {fmtMoney(r.delta)}
            {r.pct != null && (
              <span className="ml-1 opacity-70">
                ({r.pct > 0 ? "+" : ""}
                {fmtPct(r.pct)})
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TrendsTab({ data, period }: { data: ReportData; period: Period }) {
  const [basis, setBasis] = useState<Basis>("prior_period");

  const series = useMemo(() => {
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 11);
    const from = `${cutoff.toISOString().slice(0, 7)}-01`;
    const to = new Date().toISOString().slice(0, 10);
    const rows = data.txns.filter((t) => t.date >= from && t.date <= to);
    return monthlySeries(rows, data.catIndex, { from, to }, data.attribution).map((p) => ({
      ...p,
      label: monthLabel(p.month),
    }));
  }, [data.txns, data.catIndex, data.attribution]);

  const compare = useMemo(() => {
    const priorWindow = basis === "prior_year" ? priorYear(period) : priorPeriod(period);
    const pick = (w: { from: string; to: string }) =>
      data.txns.filter((t) => t.date >= w.from && t.date <= w.to);
    const current = summarize(pick(period), data.catIndex);
    const prior = summarize(pick(priorWindow), data.catIndex);
    return {
      current,
      prior,
      window: priorWindow,
      expense: compareGroups(current.expenseGroups, prior.expenseGroups),
      income: compareGroups(current.incomeGroups, prior.incomeGroups),
    };
  }, [data.txns, data.catIndex, period, basis]);

  const basisLabel = basis === "prior_year" ? "Year ago" : "Prior period";
  const hasSeries = series.some((p) => p.income || p.expense);

  const deltaTile = (label: string, cur: number, pri: number, goodWhenUp: boolean) => {
    const delta = cur - pri;
    const pct = pri !== 0 ? delta / Math.abs(pri) : null;
    const good = goodWhenUp ? delta >= 0 : delta <= 0;
    return (
      <Card>
        <CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 font-mono text-2xl">{fmtMoney(cur)}</p>
          <p className={cn("mt-0.5 text-xs", good ? "text-primary" : "text-destructive")}>
            {delta >= 0 ? "+" : ""}
            {fmtMoney(delta)}
            {pct != null && ` (${delta >= 0 ? "+" : ""}${fmtPct(pct)})`} vs {basisLabel.toLowerCase()}
          </p>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Last 12 months</CardTitle>
          <p className="text-xs text-muted-foreground">income, spending, and what stayed</p>
        </CardHeader>
        <CardContent>
          {hasSeries ? (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: TEXT_MUTED, fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                  />
                  <YAxis
                    tickFormatter={compactMoney}
                    tick={{ fill: TEXT_MUTED, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={52}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-lg">
                          <div className="mb-1 text-muted-foreground">{label}</div>
                          {payload.map((p) => (
                            <div key={p.name} className="flex items-center gap-2">
                              <span
                                className="h-2 w-2 rounded-sm"
                                style={{ background: p.color as string }}
                              />
                              <span className="flex-1">{p.name}</span>
                              <span className="font-mono">{fmtMoney(Number(p.value))}</span>
                            </div>
                          ))}
                        </div>
                      ) : null
                    }
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: TEXT_MUTED, paddingTop: 4 }}
                    iconType="square"
                    iconSize={9}
                  />
                  <Bar dataKey="income" name="Income" fill={FLOW.income} radius={[3, 3, 0, 0]} maxBarSize={22} />
                  <Bar dataKey="expense" name="Spending" fill={FLOW.spending} radius={[3, 3, 0, 0]} maxBarSize={22} />
                  <Line
                    type="monotone"
                    dataKey="net"
                    name="Net"
                    stroke={FLOW.net}
                    strokeWidth={2}
                    dot={{ r: 2.5, strokeWidth: 0, fill: FLOW.net }}
                    activeDot={{ r: 4 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No monthly history yet — this fills in as transactions accumulate.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Compare against</span>
        {(
          [
            { key: "prior_period", label: "Prior period" },
            { key: "prior_year", label: "Same period last year" },
          ] as const
        ).map((b) => (
          <button
            key={b.key}
            onClick={() => setBasis(b.key)}
            className={cn(
              "rounded-md px-2 py-1 text-xs transition-colors",
              basis === b.key
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {b.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {compare.window.from} → {compare.window.to}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {deltaTile("Income", compare.current.income, compare.prior.income, true)}
        {deltaTile("Spending", compare.current.expense, compare.prior.expense, false)}
        {deltaTile("Net", compare.current.net, compare.prior.net, true)}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spending by group</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <DeltaTable rows={compare.expense} basisLabel={basisLabel} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Income by group</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <DeltaTable rows={compare.income} basisLabel={basisLabel} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

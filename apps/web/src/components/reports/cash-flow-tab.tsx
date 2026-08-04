"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import {
  buildCashFlowSankey,
  fmtMoney,
  fmtPct,
  summarize,
  type GroupSlice,
} from "@finance/shared/src/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { hueColor, SERIES_MUTED } from "@/lib/chart-theme";
import { CashFlowSankey } from "@/components/reports/sankey";
import type { ReportData } from "@/lib/use-report-data";
import type { Period } from "@/lib/periods";

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "bad" | "neutral";
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={cn(
            "mt-1 font-mono text-2xl",
            tone === "good" && "text-primary",
            tone === "bad" && "text-destructive"
          )}
        >
          {value}
        </p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function GroupRows({
  groups,
  total,
  hueOffset,
}: {
  groups: GroupSlice[];
  total: number;
  hueOffset: number;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (!groups.length) {
    return <p className="px-3 py-4 text-sm text-muted-foreground">Nothing in this period.</p>;
  }

  return (
    <div className="divide-y divide-border">
      {groups.map((g, i) => {
        const isOpen = open.has(g.key);
        const color = i + hueOffset < 8 ? hueColor(i + hueOffset) : SERIES_MUTED;
        return (
          <div key={g.key}>
            <button
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  next.has(g.key) ? next.delete(g.key) : next.add(g.key);
                  return next;
                })
              }
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
            >
              <ChevronRight
                className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
              />
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
              <span className="flex-1 truncate">{g.name}</span>
              <span className="w-16 text-right text-xs text-muted-foreground">
                {fmtPct(total ? g.total / total : 0)}
              </span>
              <span className="w-24 text-right font-mono">{fmtMoney(g.total)}</span>
            </button>
            <div className="px-3 pb-1.5">
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, total ? (g.total / total) * 100 : 0)}%`, background: color }}
                />
              </div>
            </div>
            {isOpen && (
              <div className="bg-muted/20 px-3 pb-2 pt-1">
                {g.categories.map((c) => (
                  <div key={c.key} className="flex items-center gap-2 py-1 pl-6 text-xs">
                    <span className="flex-1 truncate text-muted-foreground">
                      {c.emoji ? `${c.emoji} ` : ""}
                      {c.name}
                      <span className="ml-1.5 opacity-60">×{c.count}</span>
                    </span>
                    <span className="w-24 text-right font-mono">{fmtMoney(c.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CashFlowTab({ data, period }: { data: ReportData; period: Period }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(640, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const inRange = useMemo(
    () => data.txns.filter((t) => t.date >= period.from && t.date <= period.to),
    [data.txns, period.from, period.to]
  );

  const summary = useMemo(() => summarize(inRange, data.catIndex), [inRange, data.catIndex]);
  const sankey = useMemo(
    () => buildCashFlowSankey(inRange, data.catIndex),
    [inRange, data.catIndex]
  );

  const hasFlow = summary.income > 0 || summary.expense > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Income" value={fmtMoney(summary.income)} sub={`${period.label.toLowerCase()}`} tone="good" />
        <Stat label="Spending" value={fmtMoney(summary.expense)} sub={`${summary.txnCount} transactions`} />
        <Stat
          label="Net"
          value={fmtMoney(summary.net)}
          sub={summary.net >= 0 ? "surplus" : "deficit — spent from savings"}
          tone={summary.net >= 0 ? "good" : "bad"}
        />
        <Stat
          label="Savings rate"
          value={fmtPct(summary.savingsRate)}
          sub={summary.transfers ? `${fmtMoney(summary.transfers)} in transfers excluded` : "transfers excluded"}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Cash flow</CardTitle>
          <p className="text-xs text-muted-foreground">
            income sources → cash in → spending groups → categories
          </p>
        </CardHeader>
        <CardContent>
          <div ref={wrapRef}>
            {hasFlow ? (
              <CashFlowSankey model={sankey} width={width} />
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No income or spending in this window. Link an institution or widen the period.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Where it went</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <GroupRows groups={summary.expenseGroups} total={summary.expense} hueOffset={summary.incomeGroups.length} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Where it came from</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <GroupRows groups={summary.incomeGroups} total={summary.income} hueOffset={0} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top merchants</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {summary.topMerchants.length ? (
                <div className="divide-y divide-border">
                  {summary.topMerchants.map((m) => (
                    <div key={m.key} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="flex-1 truncate">{m.name}</span>
                      <span className="w-10 text-right text-xs text-muted-foreground">×{m.count}</span>
                      <span className="w-24 text-right font-mono">{fmtMoney(m.total)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-3 py-4 text-sm text-muted-foreground">Nothing in this period.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

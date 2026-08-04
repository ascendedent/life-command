"use client";

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useReportData } from "@/lib/use-report-data";
import {
  PERIOD_LABELS,
  fetchFloor,
  resolvePeriod,
  type Period,
  type PeriodKind,
} from "@/lib/periods";
import { CashFlowTab } from "@/components/reports/cash-flow-tab";
import { TrendsTab } from "@/components/reports/trends-tab";
import { BuilderTab } from "@/components/reports/builder-tab";
import { TaxTab } from "@/components/reports/tax-tab";
import { RecapsTab } from "@/components/reports/recaps-tab";

type Tab = "cashflow" | "trends" | "recaps" | "builder" | "tax";

const TABS: { key: Tab; label: string }[] = [
  { key: "cashflow", label: "Cash flow" },
  { key: "trends", label: "Trends" },
  { key: "recaps", label: "Recaps" },
  { key: "builder", label: "Builder" },
  { key: "tax", label: "Business & tax" },
];

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("cashflow");
  const [kind, setKind] = useState<PeriodKind>("this_month");
  const [custom, setCustom] = useState(() => {
    const p = resolvePeriod("this_month");
    return { from: p.from, to: p.to };
  });

  const period: Period = useMemo(() => {
    if (kind === "custom") return { kind, from: custom.from, to: custom.to, label: "Custom" };
    return { kind, ...resolvePeriod(kind) };
  }, [kind, custom]);

  // Trends and YoY reach back past the selected window, so fetch a floor of 25
  // months once and let each tab slice it — one query serves every tab.
  const from = useMemo(() => fetchFloor(period.from), [period.from]);
  const to = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return period.to > today ? period.to : today;
  }, [period.to]);

  const data = useReportData(from, to);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium">Reports</h1>
        {data.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {PERIOD_LABELS.map((p) => (
            <button
              key={p.kind}
              onClick={() => setKind(p.kind)}
              className={cn(
                "rounded-md px-2 py-1 text-xs transition-colors",
                kind === p.kind
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {kind === "custom" && (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={custom.from}
            onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
            className="h-8 w-40 text-xs"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={custom.to}
            onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
            className="h-8 w-40 text-xs"
          />
        </div>
      )}

      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {data.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {data.error}
        </p>
      )}

      {tab === "cashflow" && <CashFlowTab data={data} period={period} />}
      {tab === "trends" && <TrendsTab data={data} period={period} />}
      {tab === "recaps" && <RecapsTab />}
      {tab === "builder" && <BuilderTab data={data} period={period} />}
      {tab === "tax" && <TaxTab data={data} period={period} />}
    </div>
  );
}

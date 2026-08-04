"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Save, Trash2 } from "lucide-react";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import {
  filterTxns,
  flowOf,
  fmtMoney,
  magnitude,
  summarize,
  toCsv,
  type ReportFilter,
  type ReportTxn,
} from "@finance/shared/src/reports";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { downloadText } from "@/lib/download";
import { PERIOD_LABELS, resolvePeriod, type Period, type PeriodKind } from "@/lib/periods";
import type { ReportData } from "@/lib/use-report-data";

type GroupBy = "category" | "group" | "merchant" | "month" | "account" | "none";

interface SavedReport {
  id: string;
  name: string;
  config: { filter: ReportFilter; groupBy: GroupBy; period: PeriodKind };
  created_at: string;
}

const GROUP_BYS: { key: GroupBy; label: string }[] = [
  { key: "category", label: "Category" },
  { key: "group", label: "Group" },
  { key: "merchant", label: "Merchant" },
  { key: "month", label: "Month" },
  { key: "account", label: "Account" },
  { key: "none", label: "No grouping" },
];

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-foreground"
          : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

const EMPTY: ReportFilter = {
  flow: "all",
  business: "all",
  includePending: true,
  accountIds: [],
  categoryIds: [],
  groupIds: [],
  tagIds: [],
};

export function BuilderTab({ data, period }: { data: ReportData; period: Period }) {
  const supabase = useMemo(() => createClient(), []);
  const [filter, setFilter] = useState<ReportFilter>(EMPTY);
  const [periodKind, setPeriodKind] = useState<PeriodKind>(period.kind);
  const [custom, setCustom] = useState({ from: period.from, to: period.to });
  const [groupBy, setGroupBy] = useState<GroupBy>("category");
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  const window = useMemo(
    () => (periodKind === "custom" ? custom : resolvePeriod(periodKind)),
    [periodKind, custom]
  );

  const groups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of data.cats) seen.set(c.group_id, c.group_name);
    return [...seen.entries()].map(([id, gname]) => ({ id, name: gname })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data.cats]);

  const loadSaved = useCallback(async () => {
    const { data: rows } = await supabase
      .from("saved_reports")
      .select("id, name, config, created_at")
      .order("created_at", { ascending: false });
    setSaved((rows ?? []) as SavedReport[]);
  }, [supabase]);

  useEffect(() => {
    loadSaved();
  }, [loadSaved]);

  const rows = useMemo(
    () =>
      filterTxns(
        data.txns,
        data.catIndex,
        { ...filter, from: window.from, to: window.to },
        data.tagsByTxn
      ),
    [data.txns, data.catIndex, data.tagsByTxn, filter, window]
  );

  const summary = useMemo(() => summarize(rows, data.catIndex), [rows, data.catIndex]);

  const grouped = useMemo(() => {
    if (groupBy === "none") return null;
    const acctName = new Map(data.accounts.map((a) => [a.id, a.name]));
    const buckets = new Map<string, { name: string; total: number; count: number }>();
    for (const t of rows) {
      const flow = flowOf(t, data.catIndex);
      const cat = t.category_id ? data.catIndex.get(t.category_id) : undefined;
      let key: string;
      let label: string;
      switch (groupBy) {
        case "category":
          key = cat?.id ?? "uncat";
          label = cat?.name ?? "Uncategorized";
          break;
        case "group":
          key = cat?.group_id ?? "uncat";
          label = cat?.group_name ?? "Uncategorized";
          break;
        case "merchant":
          key = t.merchant_clean || t.merchant || "Unknown";
          label = key;
          break;
        case "month":
          key = t.date.slice(0, 7);
          label = key;
          break;
        default:
          key = t.account_id;
          label = acctName.get(t.account_id) ?? "Account";
      }
      const b = buckets.get(key) ?? { name: label, total: 0, count: 0 };
      b.total += magnitude(t, flow === "income" ? "income" : "expense");
      b.count += 1;
      buckets.set(key, b);
    }
    return [...buckets.entries()]
      .map(([key, b]) => ({ key, ...b }))
      .sort((a, b) =>
        groupBy === "month" ? a.key.localeCompare(b.key) : Math.abs(b.total) - Math.abs(a.total)
      );
  }, [rows, groupBy, data.catIndex, data.accounts]);

  const toggle = (field: "accountIds" | "categoryIds" | "groupIds" | "tagIds", id: string) =>
    setFilter((f) => {
      const cur = new Set(f[field] ?? []);
      cur.has(id) ? cur.delete(id) : cur.add(id);
      return { ...f, [field]: [...cur] };
    });

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const config = { filter, groupBy, period: periodKind, custom };
    if (loadedId) {
      await supabase.from("saved_reports").update({ name: name.trim(), config }).eq("id", loadedId);
    } else {
      const { data: inserted } = await supabase
        .from("saved_reports")
        .insert({ name: name.trim(), config })
        .select("id")
        .single();
      if (inserted) setLoadedId(inserted.id as string);
    }
    setBusy(false);
    loadSaved();
  };

  const load = (r: SavedReport) => {
    const cfg = r.config as SavedReport["config"] & { custom?: { from: string; to: string } };
    setFilter({ ...EMPTY, ...cfg.filter });
    setGroupBy(cfg.groupBy ?? "category");
    setPeriodKind(cfg.period ?? "this_month");
    if (cfg.custom) setCustom(cfg.custom);
    setName(r.name);
    setLoadedId(r.id);
  };

  const remove = async (id: string) => {
    await supabase.from("saved_reports").delete().eq("id", id);
    if (loadedId === id) setLoadedId(null);
    loadSaved();
  };

  const exportCsv = () => {
    const acctName = new Map(data.accounts.map((a) => [a.id, a.name]));
    const body = toCsv([
      ["date", "merchant", "amount", "flow", "category", "group", "account", "business", "entity", "id"],
      ...rows.map((t: ReportTxn) => {
        const cat = t.category_id ? data.catIndex.get(t.category_id) : undefined;
        const flow = flowOf(t, data.catIndex);
        return [
          t.date,
          t.merchant_clean || t.merchant || "",
          magnitude(t, flow).toFixed(2),
          flow,
          cat?.name ?? "Uncategorized",
          cat?.group_name ?? "",
          acctName.get(t.account_id) ?? "",
          t.is_business ? "yes" : "no",
          t.business_entity ?? "",
          t.id,
        ];
      }),
    ]);
    downloadText(`${(name || "report").replace(/\W+/g, "-").toLowerCase()}-${window.from}_${window.to}.csv`, body);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Section title="Period">
              {PERIOD_LABELS.map((p) => (
                <Chip key={p.kind} active={periodKind === p.kind} onClick={() => setPeriodKind(p.kind)}>
                  {p.label}
                </Chip>
              ))}
            </Section>
            {periodKind === "custom" && (
              <div className="flex items-center gap-1.5">
                <Input
                  type="date"
                  value={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  className="h-7 text-xs"
                />
                <Input
                  type="date"
                  value={custom.to}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  className="h-7 text-xs"
                />
              </div>
            )}

            <Section title="Flow">
              {(["all", "expense", "income", "transfer"] as const).map((f) => (
                <Chip key={f} active={(filter.flow ?? "all") === f} onClick={() => setFilter((s) => ({ ...s, flow: f }))}>
                  {f}
                </Chip>
              ))}
            </Section>

            <Section title="Books">
              {(["all", "business", "personal"] as const).map((b) => (
                <Chip
                  key={b}
                  active={(filter.business ?? "all") === b}
                  onClick={() => setFilter((s) => ({ ...s, business: b }))}
                >
                  {b}
                </Chip>
              ))}
            </Section>

            {data.accounts.length > 0 && (
              <Section title="Accounts">
                {data.accounts.map((a) => (
                  <Chip
                    key={a.id}
                    active={(filter.accountIds ?? []).includes(a.id)}
                    onClick={() => toggle("accountIds", a.id)}
                  >
                    {a.name}
                    {a.mask ? ` ••${a.mask}` : ""}
                  </Chip>
                ))}
              </Section>
            )}

            <Section title="Category groups">
              {groups.map((g) => (
                <Chip key={g.id} active={(filter.groupIds ?? []).includes(g.id)} onClick={() => toggle("groupIds", g.id)}>
                  {g.name}
                </Chip>
              ))}
            </Section>

            {data.tags.length > 0 && (
              <Section title="Tags">
                {data.tags.map((t) => (
                  <Chip key={t.id} active={(filter.tagIds ?? []).includes(t.id)} onClick={() => toggle("tagIds", t.id)}>
                    {t.name}
                  </Chip>
                ))}
              </Section>
            )}

            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Merchant contains</p>
              <Input
                value={filter.merchant ?? ""}
                onChange={(e) => setFilter((s) => ({ ...s, merchant: e.target.value }))}
                placeholder="e.g. amazon"
                className="h-7 text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Amount between</p>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  value={filter.minAmount ?? ""}
                  onChange={(e) =>
                    setFilter((s) => ({ ...s, minAmount: e.target.value === "" ? null : Number(e.target.value) }))
                  }
                  placeholder="min"
                  className="h-7 text-xs"
                />
                <Input
                  type="number"
                  value={filter.maxAmount ?? ""}
                  onChange={(e) =>
                    setFilter((s) => ({ ...s, maxAmount: e.target.value === "" ? null : Number(e.target.value) }))
                  }
                  placeholder="max"
                  className="h-7 text-xs"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={filter.includePending ?? true}
                onChange={(e) => setFilter((s) => ({ ...s, includePending: e.target.checked }))}
                className="accent-primary"
              />
              include pending
            </label>

            <Button variant="ghost" size="sm" className="w-full" onClick={() => { setFilter(EMPTY); setLoadedId(null); setName(""); }}>
              Reset
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Saved reports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Report name"
                className="h-7 text-xs"
              />
              <Button size="sm" onClick={save} disabled={busy || !name.trim()}>
                <Save className="h-3.5 w-3.5" />
              </Button>
            </div>
            {loadedId && (
              <p className="text-[11px] text-muted-foreground">
                Editing a saved report — Save overwrites it.
              </p>
            )}
            <div className="divide-y divide-border">
              {saved.map((r) => (
                <div key={r.id} className="flex items-center gap-1.5 py-1.5 text-sm">
                  <button
                    onClick={() => load(r)}
                    className={cn(
                      "flex-1 truncate text-left hover:text-primary",
                      loadedId === r.id && "text-primary"
                    )}
                  >
                    {r.name}
                  </button>
                  <button
                    onClick={() => remove(r.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${r.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {!saved.length && <p className="py-1 text-xs text-muted-foreground">None saved yet.</p>}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: "Matched", value: String(rows.length), mono: true },
            { label: "Spending", value: fmtMoney(summary.expense) },
            { label: "Income", value: fmtMoney(summary.income) },
            { label: "Net", value: fmtMoney(summary.net) },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 font-mono text-xl">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <CardTitle className="mr-1">Group by</CardTitle>
              {GROUP_BYS.map((g) => (
                <Chip key={g.key} active={groupBy === g.key} onClick={() => setGroupBy(g.key)}>
                  {g.label}
                </Chip>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              CSV
            </Button>
          </CardHeader>
          <CardContent className="px-0">
            {grouped ? (
              grouped.length ? (
                <div className="divide-y divide-border">
                  {grouped.map((g) => (
                    <div key={g.key} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="flex-1 truncate">{g.name}</span>
                      <span className="w-12 text-right text-xs text-muted-foreground">×{g.count}</span>
                      <span className="w-28 text-right font-mono">{fmtMoney(g.total)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No transactions match these filters.
                </p>
              )
            ) : (
              <div className="divide-y divide-border">
                {rows.slice(0, 200).map((t) => {
                  const cat = t.category_id ? data.catIndex.get(t.category_id) : undefined;
                  const flow = flowOf(t, data.catIndex);
                  return (
                    <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{t.date}</span>
                      <span className="flex-1 truncate">{t.merchant_clean || t.merchant || "—"}</span>
                      <span className="w-32 truncate text-xs text-muted-foreground">
                        {cat?.name ?? "Uncategorized"}
                      </span>
                      <span className="w-24 text-right font-mono">{fmtMoney(magnitude(t, flow), { cents: true })}</span>
                    </div>
                  );
                })}
                {rows.length > 200 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    Showing 200 of {rows.length} — export the CSV for the full set.
                  </p>
                )}
                {!rows.length && (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No transactions match these filters.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

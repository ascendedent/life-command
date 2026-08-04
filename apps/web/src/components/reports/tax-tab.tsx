"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileWarning } from "lucide-react";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import { fmtMoney, magnitude, toCsv } from "@finance/shared/src/reports";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { downloadText } from "@/lib/download";
import type { Period } from "@/lib/periods";
import type { ReportData } from "@/lib/use-report-data";

interface ReceiptRef {
  kind: "file" | "email";
  label: string;
  ref: string;
}

const ALL = "__all__";

/**
 * Tax-ready output (spec §1.5): business expenses by entity, category and date
 * range, exported with the receipt reference for each line so the accountant
 * can trace any number back to its document.
 */
export function TaxTab({ data, period }: { data: ReportData; period: Period }) {
  const supabase = useMemo(() => createClient(), []);
  const [entity, setEntity] = useState<string>(ALL);
  const [groupId, setGroupId] = useState<string>(ALL);
  const [receiptFilter, setReceiptFilter] = useState<"all" | "missing">("all");
  const [receipts, setReceipts] = useState<Map<string, ReceiptRef[]>>(new Map());

  const rows = useMemo(() => {
    return data.txns
      .filter((t) => t.is_business && t.date >= period.from && t.date <= period.to)
      .filter((t) => entity === ALL || (t.business_entity ?? "Unassigned") === entity)
      .filter((t) => {
        if (groupId === ALL) return true;
        const cat = t.category_id ? data.catIndex.get(t.category_id) : undefined;
        return cat?.group_id === groupId;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [data.txns, data.catIndex, period, entity, groupId]);

  // Receipt references come from two places: files attached in the UI/drop
  // folder, and Gmail receipts the reconciler matched to the transaction.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = rows.map((r) => r.id);
      if (!ids.length) {
        setReceipts(new Map());
        return;
      }
      const map = new Map<string, ReceiptRef[]>();
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const [{ data: files }, { data: emails }] = await Promise.all([
          supabase.from("receipts").select("transaction_id, file_ref, source").in("transaction_id", slice),
          supabase
            .from("email_receipts")
            .select("matched_transaction_id, vendor, total, email_ref, external_id, source")
            .in("matched_transaction_id", slice),
        ]);
        for (const f of files ?? []) {
          const key = f.transaction_id as string;
          const list = map.get(key) ?? [];
          list.push({ kind: "file", label: (f.source as string) ?? "file", ref: f.file_ref as string });
          map.set(key, list);
        }
        for (const e of emails ?? []) {
          const key = e.matched_transaction_id as string;
          if (!key) continue;
          const list = map.get(key) ?? [];
          list.push({
            kind: "email",
            label: `email: ${(e.vendor as string) ?? "receipt"}`,
            ref: (e.email_ref as string) || `gmail:${e.external_id as string}`,
          });
          map.set(key, list);
        }
      }
      if (!cancelled) setReceipts(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, supabase]);

  const entities = useMemo(() => {
    const set = new Set<string>();
    for (const t of data.txns) if (t.is_business) set.add(t.business_entity ?? "Unassigned");
    for (const a of data.accounts) if (a.is_business && a.business_entity) set.add(a.business_entity);
    return [...set].sort();
  }, [data.txns, data.accounts]);

  const groups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of data.cats) seen.set(c.group_id, c.group_name);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data.cats]);

  const visible = useMemo(
    () => (receiptFilter === "missing" ? rows.filter((r) => !(receipts.get(r.id) ?? []).length) : rows),
    [rows, receipts, receiptFilter]
  );

  const total = visible.reduce((s, t) => s + magnitude(t, "expense"), 0);
  const missing = rows.filter((r) => !(receipts.get(r.id) ?? []).length).length;

  const byCategory = useMemo(() => {
    const buckets = new Map<string, { name: string; total: number; count: number }>();
    for (const t of visible) {
      const cat = t.category_id ? data.catIndex.get(t.category_id) : undefined;
      const key = cat?.id ?? "uncat";
      const b = buckets.get(key) ?? { name: cat?.name ?? "Uncategorized", total: 0, count: 0 };
      b.total += magnitude(t, "expense");
      b.count += 1;
      buckets.set(key, b);
    }
    return [...buckets.values()].sort((a, b) => b.total - a.total);
  }, [visible, data.catIndex]);

  const exportCsv = () => {
    const acctName = new Map(data.accounts.map((a) => [a.id, a.name]));
    const body = toCsv([
      ["date", "entity", "merchant", "amount", "category", "group", "account", "receipt_status", "receipt_refs", "transaction_id"],
      ...visible.map((t) => {
        const cat = t.category_id ? data.catIndex.get(t.category_id) : undefined;
        const refs = receipts.get(t.id) ?? [];
        return [
          t.date,
          t.business_entity ?? "Unassigned",
          t.merchant_clean || t.merchant || "",
          magnitude(t, "expense").toFixed(2),
          cat?.name ?? "Uncategorized",
          cat?.group_name ?? "",
          acctName.get(t.account_id) ?? "",
          refs.length ? "documented" : "missing",
          refs.map((r) => r.ref).join(" | "),
          t.id,
        ];
      }),
    ]);
    const slug = entity === ALL ? "all-entities" : entity.replace(/\W+/g, "-").toLowerCase();
    downloadText(`business-expenses-${slug}-${period.from}_${period.to}.csv`, body);
  };

  const Pill = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Business expenses — {period.from} to {period.to}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Entity</span>
            <Pill active={entity === ALL} onClick={() => setEntity(ALL)}>
              All
            </Pill>
            {entities.map((e) => (
              <Pill key={e} active={entity === e} onClick={() => setEntity(e)}>
                {e}
              </Pill>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Group</span>
            <Pill active={groupId === ALL} onClick={() => setGroupId(ALL)}>
              All
            </Pill>
            {groups.map(([id, gname]) => (
              <Pill key={id} active={groupId === id} onClick={() => setGroupId(id)}>
                {gname}
              </Pill>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Receipts</span>
            <Pill active={receiptFilter === "all"} onClick={() => setReceiptFilter("all")}>
              All
            </Pill>
            <Pill active={receiptFilter === "missing"} onClick={() => setReceiptFilter("missing")}>
              Missing only
            </Pill>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Deductible total</p>
            <p className="mt-1 font-mono text-2xl">{fmtMoney(total)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{visible.length} line items</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Missing receipts</p>
            <p className={cn("mt-1 font-mono text-2xl", missing > 0 && "text-warning")}>{missing}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {missing ? "attach on Transactions → Business" : "every line has a document"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex h-full flex-col justify-between pt-4">
            <div>
              <p className="text-xs text-muted-foreground">Export</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                CSV with a receipt reference per line.
              </p>
            </div>
            <Button size="sm" className="mt-2 w-full" onClick={exportCsv} disabled={!visible.length}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download CSV
            </Button>
          </CardContent>
        </Card>
      </div>

      {byCategory.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>By category</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="divide-y divide-border">
              {byCategory.map((c) => (
                <div key={c.name} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="w-12 text-right text-xs text-muted-foreground">×{c.count}</span>
                  <span className="w-28 text-right font-mono">{fmtMoney(c.total)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Line items</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {visible.length ? (
            <div className="divide-y divide-border">
              {visible.map((t) => {
                const cat = t.category_id ? data.catIndex.get(t.category_id) : undefined;
                const refs = receipts.get(t.id) ?? [];
                return (
                  <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{t.date}</span>
                    <span className="flex-1 truncate">{t.merchant_clean || t.merchant || "—"}</span>
                    <span className="hidden w-28 truncate text-xs text-muted-foreground sm:block">
                      {t.business_entity ?? "Unassigned"}
                    </span>
                    <span className="hidden w-32 truncate text-xs text-muted-foreground md:block">
                      {cat?.name ?? "Uncategorized"}
                    </span>
                    {refs.length ? (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {refs.length === 1 ? refs[0].label : `${refs.length} receipts`}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0 border-warning/40 text-[10px] text-warning">
                        <FileWarning className="mr-1 h-3 w-3" />
                        none
                      </Badge>
                    )}
                    <span className="w-24 text-right font-mono">
                      {fmtMoney(magnitude(t, "expense"), { cents: true })}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No business transactions in this window. Flag an account as business at link time, or mark
              individual transactions on Transactions → Business.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

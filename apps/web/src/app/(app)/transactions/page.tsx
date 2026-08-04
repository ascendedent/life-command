"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import { merchantKey } from "@finance/shared/src/categorize";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CategorySelect,
  type CategoryOption,
} from "@/components/transactions/category-select";
import { SplitDialog } from "@/components/transactions/split-dialog";
import { RulesManager, type RuleRow } from "@/components/transactions/rules-manager";
import { BusinessTab } from "@/components/transactions/business-tab";
import { ReceiptsTab } from "@/components/transactions/receipts-tab";
import type { TxnRow } from "@/components/transactions/txn-types";

type Tab = "all" | "review" | "business" | "receipts" | "hidden" | "rules" | "tags";
const PAGE_SIZE = 50;

const fmtAmount = (n: number) => {
  // Plaid convention: positive = outflow
  const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n < 0 ? `+${s}` : s;
};

const SOURCE_LABEL: Record<string, string> = {
  plaid: "plaid",
  rule: "rule",
  merchant_map: "map",
  llm: "llm",
  user: "user",
};

export default function TransactionsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<Tab>("all");
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [tags, setTags] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [splitTxn, setSplitTxn] = useState<TxnRow | null>(null);
  const [newTag, setNewTag] = useState("");

  // filters
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const loadStatic = useCallback(async () => {
    const [{ data: cats }, { data: accts }, { data: ruleRows }, { data: tagRows }] =
      await Promise.all([
        supabase
          .from("categories")
          .select("id, name, emoji, sort_order, category_groups (name, sort_order)")
          .eq("is_active", true),
        supabase.from("accounts").select("id, name").order("name"),
        supabase.from("txn_rules").select("*").order("priority"),
        supabase.from("tags").select("id, name, color").order("name"),
      ]);
    setCategories(
      (cats ?? []).map((c) => {
        const g = c.category_groups as unknown as { name: string; sort_order: number } | null;
        return {
          id: c.id,
          name: c.name,
          emoji: c.emoji,
          sort_order: c.sort_order,
          group_name: g?.name ?? "?",
          group_sort: g?.sort_order ?? 999,
        };
      })
    );
    setAccounts(accts ?? []);
    setRules((ruleRows ?? []) as RuleRow[]);
    setTags(tagRows ?? []);
  }, [supabase]);

  const loadTxns = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from("transactions")
      .select(
        "id, account_id, date, amount, merchant, merchant_clean, category_id, category_source, pending, hidden, needs_review, is_business, business_entity, receipt_status, parent_transaction_id, accounts (name)",
        { count: "exact" }
      )
      .order("date", { ascending: false })
      .order("id")
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (tab === "review") q = q.eq("needs_review", true).eq("hidden", false);
    else if (tab === "business") q = q.eq("is_business", true);
    else if (tab === "hidden") q = q.eq("hidden", true);
    else q = q.eq("hidden", false);

    if (search) q = q.or(`merchant.ilike.%${search}%,merchant_clean.ilike.%${search}%`);
    if (accountFilter) q = q.eq("account_id", accountFilter);
    if (categoryFilter) q = q.eq("category_id", categoryFilter);
    if (dateFrom) q = q.gte("date", dateFrom);
    if (dateTo) q = q.lte("date", dateTo);

    const { data, count } = await q;
    setTxns((data ?? []) as unknown as TxnRow[]);
    setTotal(count ?? 0);
    setLoading(false);

    const { count: rc } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("needs_review", true)
      .eq("hidden", false);
    setReviewCount(rc ?? 0);
  }, [supabase, tab, page, search, accountFilter, categoryFilter, dateFrom, dateTo]);

  useEffect(() => {
    loadStatic();
  }, [loadStatic]);
  useEffect(() => {
    loadTxns();
  }, [loadTxns]);

  /** Inline category correction: sets user source + teaches the merchant map. */
  async function setCategory(txn: TxnRow, categoryId: string) {
    await supabase
      .from("transactions")
      .update({
        category_id: categoryId,
        category_source: "user",
        needs_review: false,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", txn.id);
    const key = merchantKey(txn.merchant);
    if (key) {
      await supabase.from("merchant_map").upsert(
        {
          raw_pattern: key,
          clean_name: txn.merchant_clean,
          default_category_id: categoryId,
          source: "user",
          confidence: 1,
        },
        { onConflict: "raw_pattern" }
      );
    }
    loadTxns();
  }

  async function markReviewed(ids: string[]) {
    await supabase
      .from("transactions")
      .update({ needs_review: false, reviewed_at: new Date().toISOString() })
      .in("id", ids);
    setSelected(new Set());
    loadTxns();
  }

  async function setHidden(ids: string[], hidden: boolean) {
    await supabase.from("transactions").update({ hidden }).in("id", ids);
    setSelected(new Set());
    loadTxns();
  }

  async function bulkCategory(categoryId: string) {
    for (const id of selected) {
      const txn = txns.find((t) => t.id === id);
      if (txn) await setCategory(txn, categoryId);
    }
    setSelected(new Set());
  }

  async function createTag() {
    if (!newTag.trim()) return;
    await supabase.from("tags").insert({ name: newTag.trim() });
    setNewTag("");
    loadStatic();
  }

  async function deleteTag(id: string) {
    await supabase.from("tags").delete().eq("id", id);
    loadStatic();
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "review", label: `Review${reviewCount ? ` (${reviewCount})` : ""}` },
    { key: "business", label: "Business" },
    { key: "receipts", label: "Receipts" },
    { key: "hidden", label: "Hidden" },
    { key: "rules", label: "Rules" },
    { key: "tags", label: "Tags" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Transactions</h1>
        <span className="text-xs text-muted-foreground">
          {total.toLocaleString()} transactions
        </span>
      </div>

      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setPage(0);
              setSelected(new Set());
            }}
            className={cn(
              "border-b-2 px-3 py-1.5 text-sm transition-colors",
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "rules" ? (
        <RulesManager
          rules={rules}
          categories={categories}
          accounts={accounts}
          onChanged={() => {
            loadStatic();
            loadTxns();
          }}
        />
      ) : tab === "tags" ? (
        <div className="max-w-md space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="new tag name"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createTag()}
              className="h-8 text-sm"
            />
            <Button size="sm" onClick={createTag}>Add</Button>
          </div>
          <div className="divide-y divide-border rounded-md border">
            {tags.map((t) => (
              <div key={t.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>{t.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => deleteTag(t.id)}
                >
                  Delete
                </Button>
              </div>
            ))}
            {tags.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No tags yet — tags cut across categories (e.g. a vacation).
              </p>
            )}
          </div>
        </div>
      ) : tab === "business" ? (
        <BusinessTab txns={txns} onChanged={loadTxns} />
      ) : tab === "receipts" ? (
        <ReceiptsTab />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="search merchant…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              className="h-8 w-52 text-sm"
            />
            <select
              value={accountFilter}
              onChange={(e) => {
                setAccountFilter(e.target.value);
                setPage(0);
              }}
              className="h-8 rounded border border-input bg-background px-1.5 text-xs"
            >
              <option value="">all accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <CategorySelect
              categories={categories}
              value={categoryFilter || null}
              onChange={(id) => {
                setCategoryFilter(id);
                setPage(0);
              }}
              placeholder="all categories"
            />
            {categoryFilter && (
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setCategoryFilter("")}
              >
                clear
              </button>
            )}
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 w-36 text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 w-36 text-xs"
            />
          </div>

          {selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border bg-accent/30 px-3 py-2">
              <span className="text-xs">{selected.size} selected</span>
              <CategorySelect
                categories={categories}
                value={null}
                onChange={bulkCategory}
                placeholder="set category…"
              />
              {tab === "review" && (
                <Button size="sm" variant="outline" onClick={() => markReviewed([...selected])}>
                  Mark reviewed
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setHidden([...selected], tab !== "hidden")}
              >
                {tab === "hidden" ? "Unhide" : "Hide"}
              </Button>
            </div>
          )}

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.size === txns.length && txns.length > 0}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(txns.map((t) => t.id)) : new Set()
                        )
                      }
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Merchant</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {txns.map((t) => (
                  <tr key={t.id} className={cn(t.pending && "opacity-60")}>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(t.id);
                          else next.delete(t.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-muted-foreground">
                      {t.date}
                    </td>
                    <td className="max-w-56 px-3 py-1.5">
                      <span className="block truncate">{t.merchant_clean ?? t.merchant}</span>
                      <span className="flex gap-1">
                        {t.pending && <Badge variant="secondary">pending</Badge>}
                        {t.needs_review && <Badge variant="warning">review</Badge>}
                        {t.is_business && (
                          <Badge variant="outline">{t.business_entity ?? "business"}</Badge>
                        )}
                        {t.parent_transaction_id && <Badge variant="secondary">split</Badge>}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <CategorySelect
                          categories={categories}
                          value={t.category_id}
                          onChange={(id) => setCategory(t, id)}
                        />
                        <span
                          className="text-[10px] uppercase text-muted-foreground"
                          title="category source"
                        >
                          {SOURCE_LABEL[t.category_source ?? ""] ?? ""}
                        </span>
                      </div>
                    </td>
                    <td className="max-w-32 truncate px-3 py-1.5 text-xs text-muted-foreground">
                      {t.accounts?.name}
                    </td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-3 py-1.5 text-right font-mono",
                        Number(t.amount) < 0 && "text-primary"
                      )}
                    >
                      {fmtAmount(Number(t.amount))}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      {tab === "review" && (
                        <Button variant="ghost" size="sm" onClick={() => markReviewed([t.id])}>
                          ✓
                        </Button>
                      )}
                      {!t.parent_transaction_id && !t.pending && tab === "all" && (
                        <Button variant="ghost" size="sm" onClick={() => setSplitTxn(t)}>
                          Split
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => setHidden([t.id], !t.hidden)}
                      >
                        {t.hidden ? "Unhide" : "Hide"}
                      </Button>
                    </td>
                  </tr>
                ))}
                {!loading && txns.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      {tab === "review"
                        ? "Review inbox is empty — everything flows silently."
                        : "No transactions match."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {splitTxn && (
        <SplitDialog
          txn={splitTxn}
          categories={categories}
          onClose={(changed) => {
            setSplitTxn(null);
            if (changed) loadTxns();
          }}
        />
      )}
    </div>
  );
}

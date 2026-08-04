"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CategorySelect, type CategoryOption } from "./category-select";

export interface RuleRow {
  id: string;
  priority: number;
  criteria: {
    merchant_contains?: string;
    amount_min?: number;
    amount_max?: number;
    account_id?: string;
  };
  actions: {
    set_category_id?: string;
    rename_merchant?: string;
    hide?: boolean;
    needs_review?: boolean;
  };
  is_active: boolean;
  hit_count: number;
}

interface AccountOption { id: string; name: string }

const emptyDraft = {
  merchant_contains: "",
  amount_min: "",
  amount_max: "",
  account_id: "",
  set_category_id: null as string | null,
  rename_merchant: "",
  hide: false,
  needs_review: false,
};

export function RulesManager({
  rules,
  categories,
  accounts,
  onChanged,
}: {
  rules: RuleRow[];
  categories: CategoryOption[];
  accounts: AccountOption[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    rule_id: string;
    count: number;
    sample: { merchant: string; amount: number; date: string }[];
  } | null>(null);

  const catName = (id?: string) =>
    categories.find((c) => c.id === id)?.name ?? "—";

  async function createRule() {
    const criteria: RuleRow["criteria"] = {};
    if (draft.merchant_contains) criteria.merchant_contains = draft.merchant_contains;
    if (draft.amount_min) criteria.amount_min = Number(draft.amount_min);
    if (draft.amount_max) criteria.amount_max = Number(draft.amount_max);
    if (draft.account_id) criteria.account_id = draft.account_id;
    const actions: RuleRow["actions"] = {};
    if (draft.set_category_id) actions.set_category_id = draft.set_category_id;
    if (draft.rename_merchant) actions.rename_merchant = draft.rename_merchant;
    if (draft.hide) actions.hide = true;
    if (draft.needs_review) actions.needs_review = true;
    if (Object.keys(criteria).length === 0 || Object.keys(actions).length === 0) return;

    setBusy(true);
    const supabase = createClient();
    const maxPriority = Math.max(0, ...rules.map((r) => r.priority));
    await supabase.from("txn_rules").insert({
      priority: maxPriority + 10,
      criteria,
      actions,
    });
    setBusy(false);
    setDraft(emptyDraft);
    setShowForm(false);
    onChanged();
  }

  async function toggleActive(rule: RuleRow) {
    const supabase = createClient();
    await supabase.from("txn_rules").update({ is_active: !rule.is_active }).eq("id", rule.id);
    onChanged();
  }

  async function remove(rule: RuleRow) {
    const supabase = createClient();
    await supabase.from("txn_rules").delete().eq("id", rule.id);
    onChanged();
  }

  async function move(rule: RuleRow, dir: -1 | 1) {
    const sorted = [...rules].sort((a, b) => a.priority - b.priority);
    const idx = sorted.findIndex((r) => r.id === rule.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    const supabase = createClient();
    await supabase.from("txn_rules").update({ priority: swap.priority }).eq("id", rule.id);
    await supabase.from("txn_rules").update({ priority: rule.priority }).eq("id", swap.id);
    onChanged();
  }

  async function previewApply(rule: RuleRow) {
    setBusy(true);
    const res = await fetch("/api/rules/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule_id: rule.id, dry_run: true }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) setPreview({ rule_id: rule.id, ...data });
  }

  async function confirmApply() {
    if (!preview) return;
    setBusy(true);
    await fetch("/api/rules/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule_id: preview.rule_id, dry_run: false }),
    });
    setBusy(false);
    setPreview(null);
    onChanged();
  }

  const describe = (r: RuleRow) => {
    const c: string[] = [];
    if (r.criteria.merchant_contains) c.push(`merchant ~ "${r.criteria.merchant_contains}"`);
    if (r.criteria.amount_min != null) c.push(`≥ $${r.criteria.amount_min}`);
    if (r.criteria.amount_max != null) c.push(`≤ $${r.criteria.amount_max}`);
    if (r.criteria.account_id)
      c.push(`account ${accounts.find((a) => a.id === r.criteria.account_id)?.name ?? "?"}`);
    const a: string[] = [];
    if (r.actions.set_category_id) a.push(`→ ${catName(r.actions.set_category_id)}`);
    if (r.actions.rename_merchant) a.push(`rename "${r.actions.rename_merchant}"`);
    if (r.actions.hide) a.push("hide");
    if (r.actions.needs_review) a.push("flag for review");
    return `${c.join(" · ")}  ⇒  ${a.join(", ")}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Priority-ordered, first match wins. Retroactive apply never touches
          transactions you categorized yourself.
        </p>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "New rule"}
        </Button>
      </div>

      {showForm && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase text-muted-foreground">If</span>
            <Input
              placeholder="merchant contains…"
              value={draft.merchant_contains}
              onChange={(e) => setDraft({ ...draft, merchant_contains: e.target.value })}
              className="h-8 w-44 text-xs"
            />
            <Input
              placeholder="min $"
              type="number"
              value={draft.amount_min}
              onChange={(e) => setDraft({ ...draft, amount_min: e.target.value })}
              className="h-8 w-20 text-xs"
            />
            <Input
              placeholder="max $"
              type="number"
              value={draft.amount_max}
              onChange={(e) => setDraft({ ...draft, amount_max: e.target.value })}
              className="h-8 w-20 text-xs"
            />
            <select
              value={draft.account_id}
              onChange={(e) => setDraft({ ...draft, account_id: e.target.value })}
              className="h-8 rounded border border-input bg-background px-1.5 text-xs"
            >
              <option value="">any account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase text-muted-foreground">Then</span>
            <CategorySelect
              categories={categories}
              value={draft.set_category_id}
              onChange={(id) => setDraft({ ...draft, set_category_id: id })}
              placeholder="set category…"
            />
            <Input
              placeholder="rename merchant to…"
              value={draft.rename_merchant}
              onChange={(e) => setDraft({ ...draft, rename_merchant: e.target.value })}
              className="h-8 w-44 text-xs"
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={draft.hide}
                onChange={(e) => setDraft({ ...draft, hide: e.target.checked })}
              />
              hide
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={draft.needs_review}
                onChange={(e) => setDraft({ ...draft, needs_review: e.target.checked })}
              />
              needs review
            </label>
            <Button size="sm" onClick={createRule} disabled={busy}>
              Create
            </Button>
          </div>
        </div>
      )}

      {rules.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">No rules yet.</p>
      )}

      <div className="divide-y divide-border rounded-md border">
        {[...rules]
          .sort((a, b) => a.priority - b.priority)
          .map((r, i, arr) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="flex flex-col">
                <button
                  disabled={i === 0}
                  onClick={() => move(r, -1)}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  disabled={i === arr.length - 1}
                  onClick={() => move(r, 1)}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ▼
                </button>
              </div>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {describe(r)}
              </span>
              {!r.is_active && <Badge variant="secondary">off</Badge>}
              {r.hit_count > 0 && (
                <span className="text-xs text-muted-foreground">{r.hit_count} hits</span>
              )}
              <Button variant="ghost" size="sm" onClick={() => previewApply(r)} disabled={busy}>
                Apply to history
              </Button>
              <Button variant="ghost" size="sm" onClick={() => toggleActive(r)}>
                {r.is_active ? "Disable" : "Enable"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => remove(r)}
              >
                Delete
              </Button>
            </div>
          ))}
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-5">
            <h2 className="text-sm font-semibold">
              Retroactive apply — {preview.count} matching transactions
            </h2>
            <div className="mt-3 max-h-48 space-y-1 overflow-y-auto">
              {preview.sample.map((s, i) => (
                <p key={i} className="font-mono text-xs text-muted-foreground">
                  {s.date} · {s.merchant} · ${Math.abs(Number(s.amount)).toFixed(2)}
                </p>
              ))}
              {preview.count > preview.sample.length && (
                <p className="text-xs text-muted-foreground">
                  …and {preview.count - preview.sample.length} more
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={confirmApply} disabled={busy || preview.count === 0}>
                Apply to {preview.count}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

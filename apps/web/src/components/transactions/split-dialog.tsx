"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CategorySelect, type CategoryOption } from "./category-select";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import {
  ITEM_CATEGORY_MAP,
  type StoredItemLines,
} from "@finance/shared/src/receipt-items";

interface Txn {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  merchant: string | null;
  merchant_clean: string | null;
  is_business: boolean;
  business_entity: string | null;
  item_lines?: StoredItemLines | null;
}

/**
 * Open on the receipt's own basket when there is one.
 *
 * A parsed receipt that wasn't confident enough to split itself still knows
 * more than an empty two-way form does — which categories the order touched,
 * and what each is worth when the email priced them. Amounts stay blank when it
 * didn't, because a number nobody can source is worse than no number.
 */
function initialParts(
  txn: Txn,
  options: CategoryOption[]
): { amount: string; category_id: string | null }[] {
  const total = Number(txn.amount);
  const idOf = (name: string) => options.find((c) => c.name === name)?.id ?? null;

  const plan = txn.item_lines?.plan;
  if (plan?.parts.length) {
    return plan.parts.map((p) => ({
      amount: p.amount.toFixed(2),
      category_id: idOf(p.categoryName),
    }));
  }

  // Items were named but never priced. Offer the categories the basket touched
  // and leave the amounts to the owner — those are the numbers we don't have.
  const seen = [
    ...new Set((txn.item_lines?.coverage.categories ?? []).map((c) => ITEM_CATEGORY_MAP[c])),
  ];
  if (seen.length >= 2) {
    return seen.map((name) => ({ amount: "", category_id: idOf(name) }));
  }

  return [
    { amount: (total / 2).toFixed(2), category_id: null },
    { amount: (total / 2).toFixed(2), category_id: null },
  ];
}

export function SplitDialog({
  txn,
  categories,
  onClose,
}: {
  txn: Txn;
  categories: CategoryOption[];
  onClose: (changed: boolean) => void;
}) {
  const total = Number(txn.amount);
  const [parts, setParts] = useState(() => initialParts(txn, categories));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sum = parts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const remainder = Math.round((total - sum) * 100) / 100;

  async function save() {
    if (Math.abs(remainder) > 0.005) {
      setError(`Parts must sum to ${total.toFixed(2)} (off by ${remainder.toFixed(2)})`);
      return;
    }
    if (parts.some((p) => !p.category_id || !(Number(p.amount) > 0))) {
      setError("Every part needs a positive amount and a category.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const rows = parts.map((p) => ({
      parent_transaction_id: txn.id,
      account_id: txn.account_id,
      date: txn.date,
      amount: Number(p.amount),
      merchant: txn.merchant,
      merchant_clean: txn.merchant_clean,
      category_id: p.category_id,
      category_source: "user",
      is_business: txn.is_business,
      business_source: txn.is_business ? "user" : null,
      business_entity: txn.business_entity,
    }));
    const { error: insErr } = await supabase.from("transactions").insert(rows);
    if (insErr) {
      setBusy(false);
      setError(insErr.message);
      return;
    }
    await supabase
      .from("transactions")
      .update({ hidden: true, needs_review: false })
      .eq("id", txn.id);
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "transaction_split",
      entity: "transactions",
      entity_id: txn.id,
      detail: { parts: rows.length },
    });
    setBusy(false);
    onClose(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-5">
        <h2 className="text-sm font-semibold">
          Split “{txn.merchant_clean ?? txn.merchant}” — {total.toFixed(2)}
        </h2>
        {txn.item_lines?.items?.length ? (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2">
            <p className="mb-1 text-[11px] text-muted-foreground">
              From the receipt — {txn.item_lines.coverage.named} of{" "}
              {txn.item_lines.coverage.listed} items
              {txn.item_lines.plan.reason ? `, ${txn.item_lines.plan.reason}` : ""}
            </p>
            {txn.item_lines.items.map((i, n) => (
              <div key={n} className="flex gap-2 text-[11px] leading-tight">
                <span className="flex-1 truncate">{i.description}</span>
                <span className="text-muted-foreground">
                  {i.category ? ITEM_CATEGORY_MAP[i.category] : "—"}
                </span>
                <span className="w-14 text-right font-mono">
                  {i.amount != null ? i.amount.toFixed(2) : "—"}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mt-3 space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="number"
                step="0.01"
                value={p.amount}
                onChange={(e) => {
                  const next = [...parts];
                  next[i] = { ...p, amount: e.target.value };
                  setParts(next);
                }}
                className="h-8 w-28 font-mono text-xs"
              />
              <CategorySelect
                categories={categories}
                value={p.category_id}
                onChange={(id) => {
                  const next = [...parts];
                  next[i] = { ...p, category_id: id };
                  setParts(next);
                }}
              />
              {parts.length > 2 && (
                <button
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => setParts(parts.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <button
            className="hover:text-foreground"
            onClick={() => setParts([...parts, { amount: "0.00", category_id: null }])}
          >
            + add part
          </button>
          <span className={Math.abs(remainder) > 0.005 ? "text-warning" : ""}>
            remainder: {remainder.toFixed(2)}
          </span>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? "Splitting…" : "Split"}
          </Button>
        </div>
      </div>
    </div>
  );
}

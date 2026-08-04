"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Suggestion {
  id: string;
  transaction_id: string;
  confidence: number | null;
  rationale: string | null;
  created_at: string;
  transactions: {
    date: string;
    amount: number;
    merchant: string | null;
    merchant_clean: string | null;
  } | null;
}

const fmt = (n: number) =>
  Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Suggestion inbox for the enrichment worker's business-likelihood scores
 * (spec §1.5.2). Accepting tags the transaction business and requests a
 * receipt; dismissing is remembered so that merchant is never re-suggested.
 */
export function BusinessSuggestions({
  entities,
  onChanged,
}: {
  entities: string[];
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Suggestion[]>([]);
  const [entity, setEntity] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("business_suggestions")
      .select("id, transaction_id, confidence, rationale, created_at, transactions (date, amount, merchant, merchant_clean)")
      .eq("status", "pending")
      .order("confidence", { ascending: false });
    setRows((data ?? []) as unknown as Suggestion[]);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const accept = async (s: Suggestion) => {
    setBusy(s.id);
    await supabase
      .from("transactions")
      .update({
        is_business: true,
        business_source: "suggested_accepted",
        business_entity: entity || null,
        receipt_status: "requested", // every business expense needs a document
      })
      .eq("id", s.transaction_id);
    await supabase.from("business_suggestions").update({ status: "accepted" }).eq("id", s.id);
    setBusy(null);
    load();
    onChanged();
  };

  const dismiss = async (s: Suggestion) => {
    setBusy(s.id);
    await supabase.from("business_suggestions").update({ status: "dismissed" }).eq("id", s.id);
    setBusy(null);
    load();
  };

  if (!rows.length) return null;

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5">
      <div className="flex flex-wrap items-center gap-2 border-b border-primary/20 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-sm">
          {rows.length} possible business {rows.length === 1 ? "expense" : "expenses"} on personal
          accounts
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">tag accepted as</span>
          {entities.length ? (
            <select
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              className="h-7 rounded border border-input bg-background px-1.5 text-xs"
            >
              <option value="">Unassigned</option>
              {entities.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder="entity"
              className="h-7 w-36 text-xs"
            />
          )}
        </div>
      </div>
      <div className="divide-y divide-primary/10">
        {rows.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
              {s.transactions?.date ?? "—"}
            </span>
            <span className="min-w-32 flex-1 truncate">
              {s.transactions?.merchant_clean ?? s.transactions?.merchant ?? "—"}
            </span>
            <span className="w-20 shrink-0 text-right font-mono">
              {s.transactions ? fmt(Number(s.transactions.amount)) : "—"}
            </span>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {Math.round((s.confidence ?? 0) * 100)}%
            </Badge>
            <span className="w-full truncate text-xs text-muted-foreground sm:w-auto sm:flex-[2]">
              {s.rationale}
            </span>
            <div className="ml-auto flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => accept(s)}>
                <Check className="mr-1 h-3.5 w-3.5" />
                Business
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={busy === s.id}
                onClick={() => dismiss(s)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

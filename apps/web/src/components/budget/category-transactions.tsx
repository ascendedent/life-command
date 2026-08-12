"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * What a budget figure is actually made of.
 *
 * A budget line is an assertion — "you spent $820 on Shopping" — and the only
 * way to trust or correct it is to see the transactions underneath. Every
 * miscategorisation found on this book so far was found by asking that
 * question, and answering it used to mean going to Transactions and rebuilding
 * the same filters by hand.
 *
 * Counts dollars exactly the way the budget does: hidden = false and nothing
 * else. A split hides its parent and creates children, so filtering on
 * parent_transaction_id as well would drop every split and the total here
 * would quietly disagree with the bar it was opened from.
 */

interface Row {
  id: string;
  date: string;
  amount: number;
  merchant: string | null;
  merchant_clean: string | null;
  description: string | null;
  pending: boolean;
  accounts?: { name: string } | null;
}

export function CategoryTransactions({
  categoryId,
  categoryName,
  monthStart,
  monthEnd,
  expected,
  onClose,
}: {
  categoryId: string;
  categoryName: string;
  monthStart: string;
  monthEnd: string;
  expected: number;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("transactions")
      .select("id, date, amount, merchant, merchant_clean, description, pending, accounts (name)")
      .eq("category_id", categoryId)
      .gte("date", monthStart)
      .lt("date", monthEnd)
      .eq("hidden", false)
      .order("date", { ascending: false })
      .then(({ data }) => setRows((data ?? []) as unknown as Row[]));
  }, [categoryId, monthStart, monthEnd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const outflow = (rows ?? [])
    .filter((r) => Number(r.amount) > 0)
    .reduce((s, r) => s + Number(r.amount), 0);
  const drift = Math.round((outflow - expected) * 100) / 100;
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b p-4">
          <div>
            <h2 className="text-sm font-semibold">{categoryName}</h2>
            <p className="text-xs text-muted-foreground">
              {monthStart.slice(0, 7)} · {rows?.length ?? "…"} transaction
              {rows?.length === 1 ? "" : "s"} · {fmt(outflow)} out
              {rows && Math.abs(drift) > 0.005 && (
                <span className="text-warning">
                  {" "}
                  · {fmt(Math.abs(drift))} {drift > 0 ? "more" : "less"} than the bar shows
                </span>
              )}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows === null && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
          {rows?.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              Nothing in this category this month.
            </p>
          )}
          {rows?.map((t) => (
            <div
              key={t.id}
              className="flex items-baseline gap-3 rounded-md px-3 py-1.5 text-sm hover:bg-accent/40"
            >
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                {t.date}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {t.merchant_clean ?? t.merchant ?? "—"}
                  {t.pending && (
                    <span className="ml-1.5 text-xs text-muted-foreground">pending</span>
                  )}
                </span>
                {t.description && t.description !== (t.merchant_clean ?? t.merchant) && (
                  <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                    {t.description}
                  </span>
                )}
              </span>
              <span className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground">
                {t.accounts?.name}
              </span>
              <span
                className={`w-24 shrink-0 text-right font-mono ${
                  Number(t.amount) < 0 ? "text-primary" : ""
                }`}
              >
                {fmt(Math.abs(Number(t.amount)))}
                {Number(t.amount) < 0 ? " in" : ""}
              </span>
            </div>
          ))}
        </div>

        <div className="border-t p-3 text-right">
          {/* Reading happens here; editing belongs where the tools are. */}
          <Link
            href={`/transactions?category=${categoryId}&from=${monthStart}&to=${monthEnd}`}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Open in Transactions to edit →
          </Link>
        </div>
      </div>
    </div>
  );
}

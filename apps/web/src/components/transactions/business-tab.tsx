"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BusinessSuggestions } from "./business-suggestions";
import type { TxnRow } from "./txn-types";

const fmt = (n: number) =>
  Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function BusinessTab({
  txns,
  onChanged,
}: {
  txns: TxnRow[];
  onChanged: () => void;
}) {
  const [entityFilter, setEntityFilter] = useState<string>("");
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const business = txns.filter((t) => t.is_business);
  const entities = [...new Set(business.map((t) => t.business_entity ?? "Unassigned"))];
  const visible = entityFilter
    ? business.filter((t) => (t.business_entity ?? "Unassigned") === entityFilter)
    : business;
  const missingReceipts = business.filter((t) => t.receipt_status === "requested");

  async function uploadReceipt(txnId: string, file: File) {
    const supabase = createClient();
    const path = `${txnId}/${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage
      .from("receipts")
      .upload(path, file);
    if (upErr) {
      alert(`Upload failed: ${upErr.message}`);
      return;
    }
    await supabase.from("receipts").insert({
      transaction_id: txnId,
      file_ref: path,
      source: "ui_upload",
    });
    await supabase
      .from("transactions")
      .update({ receipt_status: "uploaded" })
      .eq("id", txnId);
    onChanged();
  }

  async function waive(txnId: string) {
    const supabase = createClient();
    await supabase
      .from("transactions")
      .update({ receipt_status: "waived" })
      .eq("id", txnId);
    onChanged();
  }

  return (
    <div className="space-y-3">
      <BusinessSuggestions
        entities={entities.filter((e) => e !== "Unassigned")}
        onChanged={onChanged}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={missingReceipts.length ? "warning" : "default"}>
          {missingReceipts.length} missing receipts
        </Badge>
        <select
          value={entityFilter}
          onChange={(e) => setEntityFilter(e.target.value)}
          className="h-8 rounded border border-input bg-background px-1.5 text-xs"
        >
          <option value="">all entities</option>
          {entities.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {visible.length} business transactions
        </span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && uploadingFor) uploadReceipt(uploadingFor, f);
          e.target.value = "";
        }}
      />

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Merchant</th>
              <th className="px-3 py-2 font-medium">Entity</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Receipt</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((t) => (
              <tr key={t.id}>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                  {t.date}
                </td>
                <td className="max-w-56 truncate px-3 py-2">
                  {t.merchant_clean ?? t.merchant}
                </td>
                <td className="px-3 py-2 text-xs">{t.business_entity ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                  {fmt(Number(t.amount))}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      t.receipt_status === "uploaded"
                        ? "default"
                        : t.receipt_status === "waived"
                          ? "secondary"
                          : "warning"
                    }
                  >
                    {t.receipt_status ?? "—"}
                  </Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {t.receipt_status === "requested" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setUploadingFor(t.id);
                          fileRef.current?.click();
                        }}
                      >
                        Upload
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => waive(t.id)}
                      >
                        Waive
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No business transactions yet — flag an account as business, or accept a
                  suggestion above once the nightly enrichment pass finds one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

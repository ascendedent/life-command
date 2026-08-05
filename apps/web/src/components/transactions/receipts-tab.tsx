"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descriptorKey, isGenericDescriptor } from "@finance/shared/src/categorize";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const fmt = (n: number | null) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

interface Anticipation {
  id: string;
  vendor: string;
  amount: number;
  card_last4: string | null;
  verification_state: string | null;
  status: string;
  created_at: string;
  expires_at: string | null;
  reconciliation_confidence: number | null;
  reconciliation_factors: (Record<string, unknown> & { candidate_transaction_id?: string }) | null;
  email_receipt_id: string | null;
  email_receipts?: { mailbox: string | null; email_ref: string | null; sender_domain?: string | null } | null;
}

function MailboxLine({ ant }: { ant: Anticipation }) {
  const mailbox = ant.email_receipts?.mailbox;
  if (!mailbox) return null;
  return (
    <span className="w-full font-mono text-[11px] text-muted-foreground">
      via {mailbox}
      {ant.email_receipts?.email_ref && (
        <>
          {" · "}
          <a
            href={ant.email_receipts.email_ref}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            open email ↗
          </a>
        </>
      )}
    </span>
  );
}

interface EmailReceipt {
  id: string;
  vendor: string | null;
  total: number | null;
  received_at: string | null;
  sender_domain: string | null;
  sender_verified: boolean;
  card_last4: string | null;
  match_status: string;
  email_ref: string | null;
  mailbox: string | null;
}

interface CandidateTxn {
  id: string;
  merchant: string | null;
  merchant_clean: string | null;
  amount: number;
  date: string;
}

export function ReceiptsTab() {
  const supabase = useMemo(() => createClient(), []);
  const [anticipations, setAnticipations] = useState<Anticipation[]>([]);
  const [receipts, setReceipts] = useState<EmailReceipt[]>([]);
  const [candidates, setCandidates] = useState<Map<string, CandidateTxn>>(new Map());
  const [ambiguousCandidates, setAmbiguousCandidates] = useState<Map<string, CandidateTxn[]>>(new Map());

  const load = useCallback(async () => {
    const [{ data: ants }, { data: recs }] = await Promise.all([
      supabase
        .from("anticipated_transactions")
        .select("*, email_receipts (mailbox, email_ref, sender_domain)")
        .in("status", ["open", "expired_review", "quarantined"])
        .order("created_at", { ascending: false }),
      supabase
        .from("email_receipts")
        .select("id, vendor, total, received_at, sender_domain, sender_verified, card_last4, match_status, email_ref, mailbox")
        .neq("match_status", "ignored")
        .order("received_at", { ascending: false })
        .limit(50),
    ]);
    const antRows = (ants ?? []) as Anticipation[];
    setAnticipations(antRows);
    setReceipts((recs ?? []) as EmailReceipt[]);

    // fetch candidate txns referenced by medium-confidence reconciliations
    const candidateIds = antRows
      .map((a) => a.reconciliation_factors?.candidate_transaction_id)
      .filter(Boolean) as string[];
    if (candidateIds.length) {
      const { data: txns } = await supabase
        .from("transactions")
        .select("id, merchant, merchant_clean, amount, date")
        .in("id", candidateIds);
      setCandidates(new Map((txns ?? []).map((t) => [t.id, t as CandidateTxn])));
    }
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  /** One-tap "Is X the same as Y?" — the answer persists as a vendor alias. */
  async function confirmMatch(ant: Anticipation, txn: CandidateTxn) {
    await supabase.from("transactions").update({ receipt_status: "uploaded" }).eq("id", txn.id);
    await supabase.from("receipts").insert({
      transaction_id: txn.id,
      file_ref: `email:${ant.email_receipt_id ?? ant.id}`,
      source: "gmail",
    });
    await supabase
      .from("anticipated_transactions")
      .update({
        status: "reconciled",
        reconciled_transaction_id: txn.id,
        reconciled_at: new Date().toISOString(),
      })
      .eq("id", ant.id);
    if (ant.email_receipt_id) {
      await supabase
        .from("email_receipts")
        .update({ match_status: "resolved", matched_transaction_id: txn.id, resolved_at: new Date().toISOString() })
        .eq("id", ant.email_receipt_id);
    }
    // Permanent memory — but only of something that can match again. A
    // descriptor like "Online Transfer to CHK ...4321 transaction#: 102938…
    // 07/17" is unique to this one payment; stored verbatim it would never
    // match, and the same question would return every month. Normalised it
    // becomes "ONLINE TRANSFER TO CHK", which is the opposite problem — it
    // would claim every transfer — so that is not stored either.
    const alias = descriptorKey(txn.merchant);
    const worthLearning = alias.length > 0 && !isGenericDescriptor(alias);

    if (worthLearning) {
      const { data: sig } = await supabase
        .from("vendor_signatures")
        .select("id, name_aliases, descriptor_patterns")
        .ilike("vendor_name", ant.vendor)
        .maybeSingle();
      if (sig) {
        await supabase
          .from("vendor_signatures")
          .update({
            name_aliases: [...new Set([...(sig.name_aliases ?? []), alias])],
            descriptor_patterns: [...new Set([...(sig.descriptor_patterns ?? []), alias])],
            source: "user_confirmed",
          })
          .eq("id", sig.id);
      } else {
        await supabase.from("vendor_signatures").insert({
          vendor_name: ant.vendor,
          name_aliases: [alias],
          descriptor_patterns: [alias],
          source: "user_confirmed",
          exact_match_count: 1,
          reliability: 1,
        });
      }
    }
    load();
  }

  async function denyMatch(ant: Anticipation) {
    await supabase
      .from("anticipated_transactions")
      .update({ reconciliation_confidence: null, reconciliation_factors: null })
      .eq("id", ant.id);
    load();
  }

  async function setAntStatus(ant: Anticipation, patch: Record<string, unknown>) {
    await supabase.from("anticipated_transactions").update(patch).eq("id", ant.id);
    load();
  }

  /**
   * "Not an expense" — a false positive, not a disputed charge.
   *
   * Dismisses the anticipation, marks the source email as never-a-receipt, and
   * offers to remember the sender so the ingester stops proposing it. That
   * last part is what stops this being whack-a-mole: a 401(k) confirmation or
   * a statement will otherwise come back every month.
   */
  async function notAnExpense(ant: Anticipation) {
    const domain = ant.email_receipts?.sender_domain ?? null;
    const remember =
      domain &&
      confirm(
        `Ignore this charge.\n\nAlso stop treating mail from "${domain}" as receipts?\n\nOK = remember the sender · Cancel = just this one`
      );

    if (ant.email_receipt_id) {
      await supabase
        .from("email_receipts")
        .update({ match_status: "ignored" })
        .eq("id", ant.email_receipt_id);
    }
    if (remember && domain) {
      await supabase.from("receipt_sender_rules").upsert(
        {
          match_type: "domain",
          pattern: domain,
          action: "ignore",
          note: `Marked not-an-expense from ${ant.vendor}`,
        },
        { onConflict: "match_type,pattern" }
      );
    }
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "receipt_not_an_expense",
      entity: "anticipated_transactions",
      entity_id: ant.id,
      detail: { vendor: ant.vendor, amount: ant.amount, sender_rule: remember ? domain : null },
    });
    await setAntStatus(ant, { status: "dismissed" });
  }

  async function flagFraud(ant: Anticipation) {
    await supabase.from("vendor_watchlist").insert({
      vendor_name: ant.vendor,
      flag_type: "fraud",
      reason: `Expired anticipation: $${Number(ant.amount).toFixed(2)} receipt never posted as a charge`,
      source: "expired_anticipation",
    });
    await setAntStatus(ant, { status: "dismissed" });
  }

  async function loadAmbiguous(receipt: EmailReceipt) {
    if (!receipt.total) return;
    const { data } = await supabase
      .from("transactions")
      .select("id, merchant, merchant_clean, amount, date")
      .gt("amount", receipt.total * 0.75)
      .lt("amount", receipt.total * 1.3)
      .is("parent_transaction_id", null)
      .order("date", { ascending: false })
      .limit(6);
    setAmbiguousCandidates(new Map(ambiguousCandidates).set(receipt.id, (data ?? []) as CandidateTxn[]));
  }

  async function resolveAmbiguous(receipt: EmailReceipt, txn: CandidateTxn) {
    await supabase.from("transactions").update({ receipt_status: "uploaded" }).eq("id", txn.id);
    await supabase.from("receipts").insert({ transaction_id: txn.id, file_ref: `email:${receipt.id}`, source: "gmail" });
    await supabase
      .from("email_receipts")
      .update({ match_status: "resolved", matched_transaction_id: txn.id, resolved_at: new Date().toISOString() })
      .eq("id", receipt.id);
    load();
  }

  const clarifications = anticipations.filter(
    (a) => a.status === "open" && a.reconciliation_factors?.candidate_transaction_id
  );
  const open = anticipations.filter(
    (a) => a.status === "open" && !a.reconciliation_factors?.candidate_transaction_id
  );
  const expired = anticipations.filter((a) => a.status === "expired_review");
  const ambiguous = receipts.filter((r) => r.match_status === "ambiguous");

  return (
    <div className="space-y-4">
      {clarifications.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader><CardTitle>Quick clarifications</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {clarifications.map((ant) => {
              const txn = candidates.get(ant.reconciliation_factors!.candidate_transaction_id!);
              if (!txn) return null;
              return (
                <div key={ant.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm">
                  <span>
                    Is <span className="font-mono">{txn.merchant}</span> the same as{" "}
                    <span className="font-mono">{ant.vendor}</span>?
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {fmt(Number(txn.amount))} vs {fmt(Number(ant.amount))}
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" onClick={() => confirmMatch(ant, txn)}>Yes — remember it</Button>
                    <Button size="sm" variant="ghost" onClick={() => denyMatch(ant)}>No</Button>
                  </span>
                  <MailboxLine ant={ant} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {expired.length > 0 && (
        <Card className="border-destructive/50">
          <CardHeader><CardTitle>Never posted — possible refund or fraud</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {expired.map((ant) => (
              <div key={ant.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm">
                <span className="font-medium">{ant.vendor}</span>
                <span className="font-mono">{fmt(Number(ant.amount))}</span>
                <span className="text-xs text-muted-foreground">
                  receipt {new Date(ant.created_at).toLocaleDateString()}, never charged
                </span>
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => setAntStatus(ant, { status: "dismissed" })}>
                    Expected (refund/cancel)
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => flagFraud(ant)}>
                    Flag fraud
                  </Button>
                </span>
                <MailboxLine ant={ant} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Anticipated charges ({open.length} open)</CardTitle>
        </CardHeader>
        <CardContent>
          {open.length ? (
            <div className="space-y-1.5">
              {open.map((ant) => (
                <div key={ant.id} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2.5 text-sm opacity-80">
                  <span>{ant.vendor}</span>
                  <span className="font-mono">{fmt(Number(ant.amount))}</span>
                  {ant.card_last4 && (
                    <span className="font-mono text-xs text-muted-foreground">…{ant.card_last4}</span>
                  )}
                  <Badge variant={ant.verification_state === "known_vendor" ? "default" : "warning"}>
                    {ant.verification_state === "known_vendor" ? "known vendor" : "unverified"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    expires {ant.expires_at ? new Date(ant.expires_at).toLocaleDateString() : "—"}
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    {ant.verification_state === "unverified_vendor" && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setAntStatus(ant, { verification_state: "user_approved" })}>
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAntStatus(ant, { status: "dismissed" })}>
                          Reject
                        </Button>
                      </>
                    )}
                    {/* Distinct from Reject: Reject says "this charge is wrong",
                        this says "this sender never produces expenses" and
                        teaches the ingester so it stops asking. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      title="Not an expense — ignore this and stop counting this sender"
                      onClick={() => notAnExpense(ant)}
                    >
                      Not an expense
                    </Button>
                  </span>
                  <MailboxLine ant={ant} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              None open — anticipated rows appear seconds after a receipt email
              lands, days before the bank posts.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Email receipts</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Received</th>
                  <th className="py-2 pr-4 font-medium">Vendor</th>
                  <th className="py-2 pr-4 text-right font-medium">Total</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {r.received_at ? new Date(r.received_at).toLocaleString() : "—"}
                    </td>
                    <td className="max-w-48 py-2 pr-4">
                      <span className="block truncate">{r.vendor}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {r.mailbox ?? r.sender_domain}
                        {!r.sender_verified && <span className="text-warning"> · unverified sender</span>}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right font-mono">{fmt(r.total)}</td>
                    <td className="py-2 pr-4">
                      <Badge
                        variant={
                          r.match_status === "auto_matched" || r.match_status === "resolved"
                            ? "default"
                            : r.match_status === "ambiguous"
                              ? "warning"
                              : "secondary"
                        }
                      >
                        {r.match_status.replace("_", " ")}
                      </Badge>
                      {r.match_status === "ambiguous" && !ambiguousCandidates.has(r.id) && (
                        <Button size="sm" variant="ghost" onClick={() => loadAmbiguous(r)}>
                          Resolve
                        </Button>
                      )}
                      {ambiguousCandidates.get(r.id)?.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => resolveAmbiguous(r, t)}
                          className="mt-1 block rounded border px-2 py-1 text-left font-mono text-xs hover:bg-accent"
                        >
                          {t.date} · {t.merchant_clean ?? t.merchant} · {fmt(Number(t.amount))}
                        </button>
                      ))}
                    </td>
                    <td className="py-2 text-right">
                      {r.email_ref && (
                        <a href={r.email_ref} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground">
                          open email ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {receipts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      No receipts yet — connect Gmail on the Account page and the
                      45-second poll starts pulling them in.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {ambiguous.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {ambiguous.length} receipt(s) in the ambiguous queue — resolve them above; each answer tunes future matching.
        </p>
      )}
    </div>
  );
}

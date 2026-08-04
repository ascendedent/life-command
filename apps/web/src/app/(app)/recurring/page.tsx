"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface RecurringItem {
  id: string;
  merchant: string;
  cadence: string | null;
  expected_amount: number | null;
  next_expected_date: string | null;
  is_subscription: boolean;
  status: string;
  purpose: string | null;
  value_notes: string | null;
  overlap_tags: string[];
  accounts?: { name: string } | null;
  categories?: { name: string; emoji: string | null } | null;
}

const fmt = (n: number | null) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const monthlyEquivalent = (item: RecurringItem): number => {
  const amt = Number(item.expected_amount ?? 0);
  if (item.cadence === "weekly") return amt * 4.33;
  if (item.cadence === "monthly") return amt;
  if (item.cadence === "annual") return amt / 12;
  return amt; // custom: treat as monthly-ish
};

export default function RecurringPage() {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<RecurringItem[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ purpose: "", value_notes: "", overlap_tags: "" });

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("recurring_items")
      .select("*, accounts (name), categories (name, emoji)")
      .neq("status", "cancelled")
      .order("next_expected_date", { ascending: true, nullsFirst: false });
    setItems((data ?? []) as unknown as RecurringItem[]);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveContext(id: string) {
    await supabase
      .from("recurring_items")
      .update({
        purpose: draft.purpose || null,
        value_notes: draft.value_notes || null,
        overlap_tags: draft.overlap_tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      })
      .eq("id", id);
    setEditing(null);
    load();
  }

  async function markCancelled(id: string) {
    await supabase.from("recurring_items").update({ status: "cancelled" }).eq("id", id);
    load();
  }

  const active = items.filter((i) => i.status !== "cancelled");
  const monthlyTotal = active.reduce((s, i) => s + monthlyEquivalent(i), 0);
  const subs = active.filter((i) => i.is_subscription);
  const flagged = active.filter((i) => i.status === "price_changed" || i.status === "missed");
  const upcoming = active
    .filter(
      (i) =>
        i.next_expected_date &&
        new Date(i.next_expected_date).getTime() < Date.now() + 30 * 86400_000
    )
    .slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Recurring</h1>
        <span className="text-xs text-muted-foreground">
          detection runs nightly at 02:00
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Monthly recurring total</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl">{fmt(monthlyTotal)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {active.length} items · {subs.length} subscriptions
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl">{flagged.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              price changes and missed charges
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Next 30 days</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {upcoming.length ? (
              upcoming.slice(0, 4).map((i) => (
                <p key={i.id} className="flex justify-between text-xs">
                  <span className="truncate">{i.merchant}</span>
                  <span className="font-mono text-muted-foreground">
                    {i.next_expected_date}
                  </span>
                </p>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">nothing expected yet</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-medium">Merchant</th>
              <th className="px-3 py-2 font-medium">Cadence</th>
              <th className="px-3 py-2 text-right font-medium">Expected</th>
              <th className="px-3 py-2 font-medium">Next</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Context</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((i) => (
              <tr key={i.id}>
                <td className="max-w-48 px-3 py-2">
                  <span className="block truncate">{i.merchant}</span>
                  <span className="text-xs text-muted-foreground">
                    {i.categories?.emoji} {i.categories?.name} · {i.accounts?.name}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {i.cadence}
                  {i.is_subscription && (
                    <Badge variant="secondary" className="ml-1.5">sub</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                  {fmt(i.expected_amount)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                  {i.next_expected_date ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      i.status === "active"
                        ? "default"
                        : i.status === "price_changed"
                          ? "warning"
                          : "destructive"
                    }
                  >
                    {i.status.replace("_", " ")}
                  </Badge>
                </td>
                <td className="max-w-64 px-3 py-2">
                  {editing === i.id ? (
                    <div className="space-y-1">
                      <Input
                        placeholder="purpose — what does this accomplish?"
                        value={draft.purpose}
                        onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
                        className="h-7 text-xs"
                      />
                      <Input
                        placeholder="value notes — usage, doubts, worth it?"
                        value={draft.value_notes}
                        onChange={(e) => setDraft({ ...draft, value_notes: e.target.value })}
                        className="h-7 text-xs"
                      />
                      <Input
                        placeholder="overlap tags (comma: ai_coding, storage…)"
                        value={draft.overlap_tags}
                        onChange={(e) => setDraft({ ...draft, overlap_tags: e.target.value })}
                        className="h-7 text-xs"
                      />
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => saveContext(i.id)}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="block w-full text-left"
                      onClick={() => {
                        setEditing(i.id);
                        setDraft({
                          purpose: i.purpose ?? "",
                          value_notes: i.value_notes ?? "",
                          overlap_tags: (i.overlap_tags ?? []).join(", "),
                        });
                      }}
                    >
                      {i.purpose ? (
                        <span className="block truncate text-xs">{i.purpose}</span>
                      ) : (
                        <span className="text-xs italic text-muted-foreground">
                          add purpose &amp; value notes — fuels Phase 2 subscription reviews
                        </span>
                      )}
                      {(i.overlap_tags ?? []).length > 0 && (
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {i.overlap_tags.map((t) => (
                            <Badge key={t} variant="outline">{t}</Badge>
                          ))}
                        </span>
                      )}
                    </button>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => markCancelled(i.id)}
                  >
                    Cancelled
                  </Button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  Nothing detected yet — recurring items appear after the nightly
                  job runs across a few weeks of synced history.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

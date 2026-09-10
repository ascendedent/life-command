"use client";

/**
 * Cards — the two facts about a card that decide what it costs and what it
 * earns, neither of which any API returns.
 *
 * A promo end date turns "0%" from a rate into a deadline: the balance is free
 * until that day and among the most expensive debt you hold the day after. The
 * countdown is therefore the headline, not the rate.
 *
 * Reward rates decide where a purchase belongs. They are entered per category
 * because that is how issuers write them, with caps and rotation dates because
 * the best rates are the ones that run out.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Grid3x3, Percent, Plus, Trash2, Wallet } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Acct {
  id: string;
  name: string;
  mask: string | null;
  current_balance: number | null;
  institutions: { name: string } | null;
}
interface Promo {
  id: string;
  account_id: string;
  kind: string;
  apr: number;
  ends_on: string;
  balance_at_start: number | null;
  post_promo_apr: number | null;
  deferred_interest: boolean;
  note: string | null;
}
interface Reward {
  id: string;
  account_id: string;
  category_id: string | null;
  rate: number;
  cap_amount: number | null;
  cap_period: string | null;
  ends_on: string | null;
  note: string | null;
}
interface Cat {
  id: string;
  name: string;
  emoji: string | null;
}
/** Mirrors RewardsPlan in @finance/shared — declared locally so this client
 *  component never imports the package barrel, which pulls in node-only code. */
interface RewardsPlan {
  rows: {
    category: string;
    annual_spend: number;
    card: string | null;
    rate: number;
    effective_rate: number;
    annual_back: number;
    ready: boolean;
    blocked_reason: string | null;
    seasonal: boolean;
    volatile: boolean;
    note: string | null;
  }[];
  total_optimal: number;
  total_if_flat: number;
  uplift: number;
  flat_rate: number;
  blocked_value: number;
  warnings: string[];
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const daysUntil = (d: string) =>
  Math.round((new Date(d + "T00:00:00").getTime() - Date.now()) / 86_400_000);

/** Red inside two months, amber inside six — the windows where action is still possible. */
function urgency(days: number): { tone: string; label: string } {
  if (days < 0) return { tone: "border-destructive text-destructive", label: "expired" };
  if (days <= 60) return { tone: "border-destructive text-destructive", label: `${days}d left` };
  if (days <= 180) return { tone: "border-amber-500 text-amber-600", label: `${days}d left` };
  return { tone: "border-input text-muted-foreground", label: `${days}d left` };
}

export default function CardsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [accts, setAccts] = useState<Acct[]>([]);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<RewardsPlan | null>(null);

  const load = useCallback(async () => {
    const [a, p, r, c] = await Promise.all([
      supabase
        .from("accounts")
        .select("id, name, mask, current_balance, institutions (name)")
        .eq("type", "credit")
        .order("current_balance", { ascending: false }),
      supabase.from("card_promos").select("*").order("ends_on"),
      supabase.from("card_rewards").select("*").order("rate", { ascending: false }),
      supabase.from("categories").select("id, name, emoji").eq("is_active", true).order("name"),
    ]);
    // PostgREST types an embedded resource as an array even when the relation
    // is to-one, so this goes through unknown rather than pretending otherwise.
    setAccts((a.data as unknown as Acct[]) ?? []);
    setPromos((p.data as Promo[]) ?? []);
    setRewards((r.data as Reward[]) ?? []);
    setCats((c.data as Cat[]) ?? []);
    // Recomputed from whatever rates are currently recorded, so editing a rate
    // above updates the plan below without anything to keep in sync by hand.
    try {
      const res = await fetch("/api/cards/plan");
      setPlan(res.ok ? ((await res.json()) as RewardsPlan) : null);
    } catch {
      setPlan(null);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addPromo(accountId: string) {
    setBusy(true);
    const ends = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    await supabase.from("card_promos").insert({ account_id: accountId, apr: 0, ends_on: ends });
    await load();
    setBusy(false);
  }
  async function addReward(accountId: string) {
    setBusy(true);
    await supabase.from("card_rewards").insert({ account_id: accountId, rate: 1 });
    await load();
    setBusy(false);
  }
  async function savePromo(id: string, patch: Partial<Promo>) {
    await supabase.from("card_promos").update(patch).eq("id", id);
    await load();
  }
  async function saveReward(id: string, patch: Partial<Reward>) {
    await supabase.from("card_rewards").update(patch).eq("id", id);
    await load();
  }
  async function del(table: string, id: string) {
    await supabase.from(table).delete().eq("id", id);
    await load();
  }

  // Categories down, cards across — the whole rate sheet without expanding
  // thirteen cards one at a time. Only cards with a recorded rate get a column,
  // so an unlinked or unrated card does not add an empty one.
  const gridCards = accts.filter((a) => rewards.some((r) => r.account_id === a.id));
  const catNameById = new Map(cats.map((c) => [c.id, c.name]));
  const gridRows = (() => {
    const byCat = new Map<string, Map<string, number>>();
    for (const r of rewards) {
      const name = r.category_id ? (catNameById.get(r.category_id) ?? "?") : "Base rate";
      const row = byCat.get(name) ?? new Map<string, number>();
      // Keep the highest if a card somehow has two rows for one category.
      row.set(r.account_id, Math.max(row.get(r.account_id) ?? 0, Number(r.rate)));
      byCat.set(name, row);
    }
    return [...byCat]
      .map(([category, cells]) => ({
        category,
        cells,
        best: Math.max(...[...cells.values()]),
      }))
      .sort((a, b) =>
        a.category === "Base rate" ? 1 : b.category === "Base rate" ? -1 : a.category.localeCompare(b.category)
      );
  })();

  // Every promo across every card, soonest first — the calendar that decides
  // when cash has to stop earning interest and start retiring a balance.
  const cliffs = promos
    .map((p) => ({ p, acct: accts.find((a) => a.id === p.account_id), days: daysUntil(p.ends_on) }))
    .filter((x) => x.acct)
    .sort((a, b) => a.days - b.days);
  const atRisk = cliffs.reduce((s, x) => s + Number(x.p.balance_at_start ?? x.acct?.current_balance ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Cards</h1>
        <span className="text-xs text-muted-foreground">
          Rates and end dates live on the statement, not in any API — enter them once.
        </span>
      </div>

      {cliffs.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="h-4 w-4" /> Promo calendar
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {fmt(atRisk)} across {cliffs.length} promo{cliffs.length === 1 ? "" : "s"}. Each
              balance is interest-free until its date and reprices the day after.
            </p>
            {cliffs.map(({ p, acct, days }) => {
              const u = urgency(days);
              const bal = Number(p.balance_at_start ?? acct?.current_balance ?? 0);
              const post = p.post_promo_apr != null ? Number(p.post_promo_apr) : null;
              return (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="font-medium">
                    {acct?.institutions?.name && (
                      <span className="mr-1.5 text-xs font-normal uppercase text-muted-foreground">
                        {acct.institutions.name}
                      </span>
                    )}
                    {acct?.name} ‥{acct?.mask}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {p.deferred_interest && (
                      <Badge variant="outline" className="border-destructive text-destructive">
                        <AlertTriangle className="mr-1 h-3 w-3" /> deferred interest
                      </Badge>
                    )}
                    <span className="text-muted-foreground">{fmt(bal)}</span>
                    <span className="text-muted-foreground">
                      {Number(p.apr)}% → {post != null ? `${post}%` : "?"}
                    </span>
                    <Badge variant="outline" className={u.tone}>
                      {p.ends_on} · {u.label}
                    </Badge>
                    {post != null && days >= 0 && (
                      <span className="text-xs text-muted-foreground">
                        ≈{fmt((bal * post) / 100 / 12)}/mo after
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {rewards.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Grid3x3 className="h-4 w-4" /> Every rate, by category
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              The best rate in each row is highlighted. A blank cell means that card has no
              recorded rate for that category and would earn its base rate. Click a card below to
              edit its rates.
            </p>
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase text-muted-foreground">
                    <th className="sticky left-0 bg-background py-1.5 pr-3 text-left">Category</th>
                    {gridCards.map((a) => (
                      <th
                        key={a.id}
                        className="px-2 py-1.5 text-right font-normal align-bottom"
                        title={a.name}
                      >
                        <div className="whitespace-nowrap text-foreground">
                          {a.institutions?.name ?? "—"}
                        </div>
                        <div className="whitespace-nowrap">‥{a.mask}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {gridRows.map(({ category, cells, best }) => (
                    <tr key={category} className="border-b border-border/40">
                      <td className="sticky left-0 bg-background py-1.5 pr-3 whitespace-nowrap">
                        {category}
                      </td>
                      {gridCards.map((a) => {
                        const v = cells.get(a.id);
                        return (
                          <td
                            key={a.id}
                            className={`px-2 py-1.5 text-right tabular-nums ${
                              v != null && v === best ? "font-semibold text-primary" : "text-muted-foreground"
                            }`}
                          >
                            {v != null ? `${v}%` : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {plan && plan.rows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" /> Where each dollar should go
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {fmt(plan.total_optimal)}/yr placing each category on its best card, against{" "}
              {fmt(plan.total_if_flat)}/yr putting everything on one {plan.flat_rate}% card —{" "}
              <span className="font-medium text-foreground">{fmt(plan.uplift)}/yr</span> for sorting
              it. Spending is the median of the last six months, so a one-off does not set the plan.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-1.5 pr-3">Category</th>
                    <th className="py-1.5 pr-3 text-right">Spend/yr</th>
                    <th className="py-1.5 pr-3">Card</th>
                    <th className="py-1.5 pr-3 text-right">Rate</th>
                    <th className="py-1.5 pr-3 text-right">Back/yr</th>
                    <th className="py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r) => (
                    <tr key={r.category} className="border-b border-border/40">
                      <td className="py-1.5 pr-3">
                        {r.category}
                        {r.volatile && (
                          <span className="ml-1.5 text-xs text-amber-600" title="the latest month is well off the six-month median — this estimate may be stale">
                            changed
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.annual_spend)}</td>
                      <td className="py-1.5 pr-3">{r.card ?? <span className="text-muted-foreground">any flat-rate card</span>}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {r.rate}%
                        {r.effective_rate !== r.rate && (
                          <span className="text-muted-foreground"> → {r.effective_rate}%</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.annual_back)}</td>
                      <td className="py-1.5">
                        {r.ready ? (
                          <span className="text-muted-foreground">ready</span>
                        ) : (
                          <span className="text-destructive">{r.blocked_reason}</span>
                        )}
                        {r.seasonal && <span className="ml-1.5 text-xs text-muted-foreground">seasonal</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {plan.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-600">{w}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {accts.map((a) => {
          const mine = promos.filter((p) => p.account_id === a.id);
          const rw = rewards.filter((r) => r.account_id === a.id);
          const isOpen = open === a.id;
          const best = rw.reduce((m, r) => Math.max(m, Number(r.rate)), 0);
          return (
            <Card key={a.id}>
              <CardHeader
                className="cursor-pointer pb-3"
                onClick={() => setOpen(isOpen ? null : a.id)}
              >
                <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span>
                    {a.institutions?.name && (
                      <span className="mr-1.5 text-xs uppercase text-muted-foreground">
                        {a.institutions.name}
                      </span>
                    )}
                    {a.name} <span className="text-muted-foreground">‥{a.mask}</span>
                  </span>
                  <span className="flex items-center gap-2 text-sm font-normal">
                    <span className="text-muted-foreground">{fmt(a.current_balance)}</span>
                    {mine.map((p) => {
                      const u = urgency(daysUntil(p.ends_on));
                      return (
                        <Badge key={p.id} variant="outline" className={u.tone}>
                          {Number(p.apr)}% · {u.label}
                        </Badge>
                      );
                    })}
                    {best > 0 && (
                      <Badge variant="outline">
                        <Percent className="mr-1 h-3 w-3" />
                        up to {best}%
                      </Badge>
                    )}
                  </span>
                </CardTitle>
              </CardHeader>
              {isOpen && (
                <CardContent className="space-y-5">
                  <section className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs uppercase text-muted-foreground">
                        Promotional rates
                      </Label>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => addPromo(a.id)}>
                        <Plus className="mr-1 h-3 w-3" /> Add promo
                      </Button>
                    </div>
                    {mine.length === 0 && (
                      <p className="text-sm text-muted-foreground">No promo recorded.</p>
                    )}
                    {mine.map((p) => (
                      <div key={p.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-6">
                        <div>
                          <Label className="text-xs">Rate %</Label>
                          <Input
                            type="number" step="0.01" defaultValue={Number(p.apr)}
                            onBlur={(e) => savePromo(p.id, { apr: Number(e.target.value) })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Ends on</Label>
                          <Input
                            type="date" defaultValue={p.ends_on}
                            onBlur={(e) => savePromo(p.id, { ends_on: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Balance</Label>
                          <Input
                            type="number" step="0.01" defaultValue={p.balance_at_start ?? ""}
                            placeholder="current"
                            onBlur={(e) =>
                              savePromo(p.id, {
                                balance_at_start: e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Reprices to %</Label>
                          <Input
                            type="number" step="0.01" defaultValue={p.post_promo_apr ?? ""}
                            onBlur={(e) =>
                              savePromo(p.id, {
                                post_promo_apr: e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Applies to</Label>
                          <select
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                            defaultValue={p.kind}
                            onChange={(e) => savePromo(p.id, { kind: e.target.value })}
                          >
                            <option value="balance_transfer">Balance transfer</option>
                            <option value="purchase">Purchases</option>
                            <option value="both">Both</option>
                          </select>
                        </div>
                        <div className="flex items-end justify-between gap-2">
                          <label className="flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox" defaultChecked={p.deferred_interest}
                              onChange={(e) => savePromo(p.id, { deferred_interest: e.target.checked })}
                            />
                            Deferred
                          </label>
                          <Button size="sm" variant="ghost" onClick={() => del("card_promos", p.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {mine.some((p) => p.deferred_interest) && (
                      <p className="text-xs text-destructive">
                        Deferred interest: if the balance is not cleared by the end date, interest
                        is charged back to day one — not just going forward.
                      </p>
                    )}
                  </section>

                  <section className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs uppercase text-muted-foreground">
                        Cash back — leave the category blank for the base rate
                      </Label>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => addReward(a.id)}>
                        <Plus className="mr-1 h-3 w-3" /> Add rate
                      </Button>
                    </div>
                    {rw.length === 0 && (
                      <p className="text-sm text-muted-foreground">No rates recorded.</p>
                    )}
                    {rw.map((r) => (
                      <div key={r.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-6">
                        <div className="sm:col-span-2">
                          <Label className="text-xs">Category</Label>
                          <select
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                            defaultValue={r.category_id ?? ""}
                            onChange={(e) =>
                              saveReward(r.id, { category_id: e.target.value || null })
                            }
                          >
                            <option value="">Everything else (base)</option>
                            {cats.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.emoji ? `${c.emoji} ` : ""}
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <Label className="text-xs">Rate %</Label>
                          <Input
                            type="number" step="0.01" defaultValue={Number(r.rate)}
                            onBlur={(e) => saveReward(r.id, { rate: Number(e.target.value) })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Cap</Label>
                          <Input
                            type="number" step="0.01" defaultValue={r.cap_amount ?? ""}
                            placeholder="none"
                            onBlur={(e) =>
                              saveReward(r.id, {
                                cap_amount: e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Per</Label>
                          <select
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                            defaultValue={r.cap_period ?? ""}
                            onChange={(e) => saveReward(r.id, { cap_period: e.target.value || null })}
                          >
                            <option value="">—</option>
                            <option value="month">month</option>
                            <option value="quarter">quarter</option>
                            <option value="year">year</option>
                          </select>
                        </div>
                        <div className="flex items-end justify-between gap-2">
                          <div className="flex-1">
                            <Label className="text-xs">Rotates until</Label>
                            <Input
                              type="date" defaultValue={r.ends_on ?? ""}
                              onBlur={(e) => saveReward(r.id, { ends_on: e.target.value || null })}
                            />
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => del("card_rewards", r.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </section>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

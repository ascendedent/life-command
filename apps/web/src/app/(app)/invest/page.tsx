"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Position {
  symbol: string;
  side: string;
  qty: number;
  avg_entry_price: number;
  current_price: number;
  market_value: number;
  cost_basis: number;
  unrealized_pl: number;
  unrealized_plpc: number;
  change_today: number;
}

interface Order {
  id: string;
  symbol: string;
  side: string;
  qty: number | null;
  notional: number | null;
  filled_qty: number | null;
  filled_avg_price: number | null;
  type: string;
  status: string;
  submitted_at: string;
  from_platform: boolean;
}

interface Execution {
  id: string;
  created_at: string;
  mode: string;
  request: { symbol?: string; side?: string; amount?: number } | null;
  outcome: string;
  violations: string[];
  broker_order_id: string | null;
  error: string | null;
  recommendations: { summary: string } | null;
}

interface InvestData {
  configured: boolean;
  mode: "paper" | "live";
  account: {
    status: string;
    cash: number;
    equity: number;
    buying_power: number;
    pattern_day_trader: boolean;
  } | null;
  positions: Position[];
  orders: Order[];
  executions: Execution[];
  error: string | null;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;

/** Gain and loss are a state, not a series — they wear the status colours. */
const plClass = (n: number) =>
  n > 0 ? "text-success" : n < 0 ? "text-destructive" : "text-muted-foreground";

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 font-mono text-lg">{value}</p>
        {sub && <p className="mt-0.5 text-xs">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function InvestPage() {
  const [data, setData] = useState<InvestData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const res = await fetch("/api/invest");
    if (res.ok) setData(await res.json());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Asking the broker…
      </div>
    );
  }

  const invested = data.positions.reduce((s, p) => s + p.market_value, 0);
  const unrealized = data.positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const largest = Math.max(1, ...data.positions.map((p) => Math.abs(p.market_value)));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Investments</h1>
        <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/*
        The mode banner is always visible, never a subtle badge in a corner.
        Every figure below means something different depending on this one word,
        and a page that shows six figures of paper money without saying so is
        the most misleading screen in the platform.
      */}
      <div
        className={cn(
          "rounded-md border p-3 text-sm",
          data.mode === "live"
            ? "border-destructive/40 bg-destructive/10"
            : "border-border bg-muted/40"
        )}
      >
        {data.mode === "live" ? (
          <span>
            <span className="font-medium text-destructive">Live</span> — these are
            real positions and real money.
          </span>
        ) : (
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">Paper</span> — simulated
            money at the broker. None of it is on your balance sheet, and none of
            it counts toward net worth.
          </span>
        )}
      </div>

      {!data.configured && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No broker is configured. Set <code>ALPACA_KEY_ID</code> and{" "}
            <code>ALPACA_SECRET_KEY</code>, run <code>npm run env:sync</code>, and
            the Execution card on the Agent page will walk the rest.
          </CardContent>
        </Card>
      )}

      {data.error && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            The broker did not answer: {data.error}. Nothing executes while its
            state is unknown — an unreachable broker is not a verdict on any
            position, and this resumes on its own.
          </CardContent>
        </Card>
      )}

      {data.account && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Equity" value={money(data.account.equity)} />
          <Stat label="Cash" value={money(data.account.cash)} />
          <Stat label="Buying power" value={money(data.account.buying_power)} />
          <Stat
            label="Unrealized P&L"
            value={data.positions.length ? signed(unrealized) : "—"}
            sub={
              data.positions.length ? (
                <span className={plClass(unrealized)}>
                  {invested ? pct(unrealized / (invested - unrealized)) : ""} on{" "}
                  {money(invested)} invested
                </span>
              ) : (
                <span className="text-muted-foreground">nothing held</span>
              )
            }
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Positions</CardTitle>
        </CardHeader>
        <CardContent>
          {data.positions.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Symbol</th>
                    <th className="py-2 pr-4 text-right font-medium">Qty</th>
                    <th className="py-2 pr-4 text-right font-medium">Entry</th>
                    <th className="py-2 pr-4 text-right font-medium">Last</th>
                    <th className="py-2 pr-4 text-right font-medium">Value</th>
                    <th className="py-2 pr-4 text-right font-medium">P&amp;L</th>
                    <th className="py-2 font-medium">Allocation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.positions.map((p) => (
                    <tr key={p.symbol}>
                      <td className="py-2 pr-4 font-medium">{p.symbol}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{p.qty}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs text-muted-foreground">
                        {money(p.avg_entry_price)}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">
                        {money(p.current_price)}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">
                        {money(p.market_value)}
                      </td>
                      <td className={cn("py-2 pr-4 text-right font-mono text-xs", plClass(p.unrealized_pl))}>
                        {signed(p.unrealized_pl)}
                        <span className="ml-1.5 opacity-70">{pct(p.unrealized_plpc)}</span>
                      </td>
                      {/*
                        A bar per row rather than a pie: the share is readable
                        against its own label, the rows stay sortable, and a
                        ninth position does not need a ninth colour.
                      */}
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${(Math.abs(p.market_value) / largest) * 100}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs text-muted-foreground">
                            {invested ? pct(p.market_value / invested) : "—"}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No open positions. Approve a trade in the queue and it lands here.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Orders at the broker</CardTitle>
        </CardHeader>
        <CardContent>
          {data.orders.length ? (
            <div className="space-y-1.5">
              {data.orders.map((o) => (
                <div key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 text-xs last:border-0">
                  <span className="w-32 font-mono text-muted-foreground">
                    {new Date(o.submitted_at).toLocaleString()}
                  </span>
                  <span className="font-medium uppercase">
                    {o.side} {o.symbol}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {o.notional != null ? money(o.notional) : `${o.qty} sh`} {o.type}
                  </span>
                  <Badge variant={o.status === "filled" ? "default" : "outline"}>{o.status}</Badge>
                  {o.filled_avg_price != null && (
                    <span className="font-mono text-muted-foreground">
                      filled {o.filled_qty} at {money(o.filled_avg_price)}
                    </span>
                  )}
                  {!o.from_platform && (
                    <span className="text-muted-foreground">placed outside Life Command</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No orders yet.
            </p>
          )}
        </CardContent>
      </Card>

      {/*
        Our own ledger, not the broker's. It is the only place a refusal is
        visible: an order the guardrails stopped never reached Alpaca, so the
        list above will never mention it, and "nothing happened" is exactly what
        a broken guardrail looks like too.
      */}
      <Card>
        <CardHeader>
          <CardTitle>What this platform attempted</CardTitle>
        </CardHeader>
        <CardContent>
          {data.executions.length ? (
            <div className="space-y-1.5">
              {data.executions.map((e) => (
                <div key={e.id} className="border-b py-1.5 text-xs last:border-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="w-32 font-mono text-muted-foreground">
                      {new Date(e.created_at).toLocaleString()}
                    </span>
                    <span className="font-medium uppercase">
                      {e.request?.side} {e.request?.symbol}
                    </span>
                    {e.request?.amount != null && Number.isFinite(e.request.amount) && (
                      <span className="font-mono text-muted-foreground">
                        {money(e.request.amount)}
                      </span>
                    )}
                    <Badge
                      variant={
                        e.outcome === "submitted" || e.outcome === "filled"
                          ? "default"
                          : e.outcome === "rejected"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {e.outcome}
                    </Badge>
                    <Badge variant="outline">{e.mode}</Badge>
                  </div>
                  {e.violations?.length > 0 && (
                    <ul className="mt-1 space-y-0.5 pl-32 text-muted-foreground">
                      {e.violations.map((v) => (
                        <li key={v}>{v}</li>
                      ))}
                    </ul>
                  )}
                  {e.error && <p className="mt-1 pl-32 text-destructive">{e.error}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing attempted yet. Refusals appear here too — they are the
              evidence the guardrails hold.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

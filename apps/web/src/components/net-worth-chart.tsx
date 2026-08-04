"use client";

import { useMemo, useState } from "react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

interface Snapshot {
  date: string;
  total: number;
}

const RANGES = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "365d" },
] as const;

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export function NetWorthChart({ snapshots }: { snapshots: Snapshot[] }) {
  const [days, setDays] = useState<number>(90);

  const data = useMemo(() => {
    const cutoff = Date.now() - days * 86400_000;
    return snapshots
      .filter((s) => new Date(s.date).getTime() >= cutoff)
      .map((s) => ({ ...s, total: Number(s.total) }));
  }, [snapshots, days]);

  const latest = data.at(-1);
  const first = data[0];
  const delta = latest && first ? latest.total - first.total : 0;

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <p className="font-mono text-2xl">
            {latest ? fmtMoney(latest.total) : "—"}
          </p>
          {latest && first && data.length > 1 && (
            <p
              className={cn(
                "mt-0.5 text-xs",
                delta >= 0 ? "text-primary" : "text-destructive"
              )}
            >
              {delta >= 0 ? "+" : ""}
              {fmtMoney(delta)} over {days}d
            </p>
          )}
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs transition-colors",
                days === r.days
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {data.length > 1 ? (
        <div className="mt-2 h-16">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
              <YAxis domain={["dataMin", "dataMax"]} hide />
              <Tooltip
                cursor={{ stroke: "hsl(222 14% 30%)", strokeWidth: 1 }}
                content={({ active, payload }) =>
                  active && payload?.[0] ? (
                    <div className="rounded-md border bg-card px-2 py-1 text-xs shadow-md">
                      <span className="text-muted-foreground">
                        {payload[0].payload.date}
                      </span>{" "}
                      <span className="font-mono">
                        {fmtMoney(payload[0].payload.total)}
                      </span>
                    </div>
                  ) : null
                }
              />
              <Line
                type="monotone"
                dataKey="total"
                stroke="hsl(152 65% 45%)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Sparkline appears after a couple of daily snapshots.
        </p>
      )}
    </div>
  );
}

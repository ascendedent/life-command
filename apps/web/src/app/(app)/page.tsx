import { Activity, Inbox, Landmark, PiggyBank, Target } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NetWorthChart } from "@/components/net-worth-chart";
import { OverviewAdvice } from "@/components/overview-advice";
import { LinkInstitution } from "@/components/link-institution";
import { SyncNow } from "@/components/sync-now";

export const dynamic = "force-dynamic";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const fmtMoney = (n: number | null) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

export default async function OverviewPage() {
  const supabase = createClient();

  const [
    { data: institutions },
    { data: snapshots },
    { data: heartbeats },
    { count: pendingRecs },
    { count: goalCount },
  ] = await Promise.all([
    supabase
      .from("institutions")
      .select(
        "id, name, status, last_sync_at, last_error, accounts (id, name, type, subtype, mask, current_balance, is_business, business_entity, household_members (name))"
      )
      .order("name"),
    supabase.from("net_worth_snapshots").select("date, total").order("date").limit(400),
    supabase.from("worker_heartbeats").select("*").order("worker_name"),
    supabase
      .from("recommendations")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase.from("goals").select("*", { count: "exact", head: true }),
  ]);

  const hasInstitutions = (institutions?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
        <div className="flex items-center gap-2">
          {hasInstitutions && <SyncNow />}
          <LinkInstitution />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="sm:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <PiggyBank className="h-3.5 w-3.5" /> Net worth
            </CardTitle>
          </CardHeader>
          <CardContent>
            <NetWorthChart snapshots={(snapshots ?? []).map((s) => ({
              date: s.date,
              total: Number(s.total),
            }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5" /> Goals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl">{goalCount ?? 0}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Goal wizard arrives in Phase 2
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Inbox className="h-3.5 w-3.5" /> Pending recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl">{pendingRecs ?? 0}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {pendingRecs
                ? "awaiting acknowledgement in the queue"
                : "nothing waiting on you"}
            </p>
          </CardContent>
        </Card>
      </div>

      <OverviewAdvice />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Landmark className="h-3.5 w-3.5" /> Accounts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {hasInstitutions ? (
            <div className="space-y-4">
              {institutions!.map((inst) => (
                <div key={inst.id}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{inst.name}</span>
                    <Badge variant={inst.status === "ok" ? "default" : "destructive"}>
                      {inst.status === "ok"
                        ? `synced ${relativeTime(inst.last_sync_at)}`
                        : "connection error"}
                    </Badge>
                    {inst.status !== "ok" && (
                      <LinkInstitution institutionId={inst.id} compact />
                    )}
                  </div>
                  {inst.last_error && (
                    <p className="mt-0.5 text-xs text-destructive">{inst.last_error}</p>
                  )}
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {(inst.accounts ?? []).map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between rounded-md border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">{a.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.subtype ?? a.type}
                            {a.mask ? ` · …${a.mask}` : ""}
                            {a.is_business && (
                              <span className="text-warning">
                                {" "}
                                · {a.business_entity ?? "business"}
                              </span>
                            )}
                            {/* Whose account it is, when the household has
                                more than one person to tell apart. */}
                            {(a.household_members as unknown as { name: string } | null)
                              ?.name && (
                              <span>
                                {" "}
                                ·{" "}
                                {
                                  (a.household_members as unknown as { name: string })
                                    .name
                                }
                              </span>
                            )}
                          </p>
                        </div>
                        <p className="font-mono text-sm">
                          {fmtMoney(a.current_balance)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No institutions linked yet — use “Link institution” to connect
              your first account{process.env.PLAID_ENV === "sandbox"
                ? " (sandbox: any bank, user_good / pass_good)"
                : ""}.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" /> System status
          </CardTitle>
        </CardHeader>
        <CardContent>
          {heartbeats && heartbeats.length > 0 ? (
            <div className="divide-y divide-border">
              {heartbeats.map((hb) => {
                const stale =
                  Date.now() - new Date(hb.last_beat_at).getTime() > 120_000;
                return (
                  <div
                    key={hb.worker_name}
                    className="flex items-center justify-between py-2 text-sm"
                  >
                    <span className="font-mono">{hb.worker_name}</span>
                    <span className="flex items-center gap-3">
                      <Badge
                        variant={
                          stale
                            ? "destructive"
                            : hb.status === "stub"
                              ? "secondary"
                              : "default"
                        }
                      >
                        {stale ? "stale" : hb.status}
                      </Badge>
                      <span className="w-20 text-right font-mono text-xs text-muted-foreground">
                        {relativeTime(hb.last_beat_at)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No worker heartbeats yet — start the workers with{" "}
              <code className="font-mono text-xs">npm run svc:start</code>.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

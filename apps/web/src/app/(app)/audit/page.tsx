import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const ACTOR_VARIANT = {
  agent: "default",
  user: "secondary",
  executor: "warning",
  system: "outline",
} as const;

export default async function AuditPage() {
  const supabase = createClient();
  const { data: rows } = await supabase
    .from("audit_log")
    .select("*")
    .order("at", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Audit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Append-only log of everything the system ever did. Immutable by
          database trigger.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Last {rows?.length ?? 0} events</CardTitle>
        </CardHeader>
        <CardContent>
          {rows && rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Time</th>
                    <th className="py-2 pr-4 font-medium">Actor</th>
                    <th className="py-2 pr-4 font-medium">Action</th>
                    <th className="py-2 pr-4 font-medium">Entity</th>
                    <th className="py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs text-muted-foreground">
                        {new Date(r.at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={
                            ACTOR_VARIANT[
                              r.actor as keyof typeof ACTOR_VARIANT
                            ] ?? "outline"
                          }
                        >
                          {r.actor}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.action}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                        {r.entity ?? "—"}
                      </td>
                      <td className="max-w-md truncate py-2 font-mono text-xs text-muted-foreground">
                        {r.detail ? JSON.stringify(r.detail) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing logged yet. Worker boots, approvals, executions and
              breaker trips will all land here.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

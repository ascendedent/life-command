import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerName } from "@finance/shared";

export async function beat(
  db: SupabaseClient,
  worker: WorkerName,
  status: string = "ok",
  details?: Record<string, unknown>
) {
  const row: Record<string, unknown> = {
    worker_name: worker,
    status,
    last_beat_at: new Date().toISOString(),
  };
  if (details?.booted) row.started_at = new Date().toISOString();
  if (details) row.details = details;

  const { error } = await db
    .from("worker_heartbeats")
    .upsert(row, { onConflict: "worker_name" });
  if (error) console.error(`[heartbeat] ${worker}: ${error.message}`);
}

export async function markStopped(db: SupabaseClient, worker: WorkerName) {
  const { error } = await db
    .from("worker_heartbeats")
    .update({ status: "stopped", last_beat_at: new Date().toISOString() })
    .eq("worker_name", worker);
  if (error) console.error(`[heartbeat] ${worker}: ${error.message}`);
}

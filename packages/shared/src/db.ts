import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side client for workers and scripts. Uses the service-role key,
 * which bypasses RLS — must never be imported into browser code.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — run `npm run env:sync` after `supabase start`"
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AuditActor = "agent" | "user" | "executor" | "system";

/** Append a row to the immutable audit log. */
export async function audit(
  db: SupabaseClient,
  actor: AuditActor,
  action: string,
  entity?: string,
  entityId?: string,
  detail?: Record<string, unknown>
) {
  const { error } = await db.from("audit_log").insert({
    actor,
    action,
    entity: entity ?? null,
    entity_id: entityId ?? null,
    detail: detail ?? null,
  });
  if (error) console.error(`[audit] failed to log ${action}:`, error.message);
}

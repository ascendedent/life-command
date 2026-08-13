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

/**
 * Read every row a query matches, not the first thousand.
 *
 * PostgREST caps a response at `db-max-rows` (1,000 by default, and this is a
 * server setting a client cannot raise): `.limit(5000)` returns 1,000, and so
 * does `.range(0, 4999)`. Nothing errors. The query simply returns fewer rows
 * than it matched, and every total computed from it is quietly wrong.
 *
 * This was not theoretical. Recurring detection selected 400 days of outflows
 * ordered by date ascending with no limit, matched 1,459 rows, received the
 * oldest 1,000, and so believed the world ended on 17 May. Every recurring bill
 * was frozen there and marked `missed` — including ones charged on the 2nd of
 * this month — and the cash floors then reserved money against those phantom
 * overdue bills. A truncation three layers away came out as the wrong amount of
 * spendable cash.
 *
 * Ordering matters more than it looks: truncating a DESC query loses the oldest
 * rows, which is usually survivable; truncating an ASC query loses the newest,
 * which is how a whole subsystem ends up living in the past.
 *
 * The supplied builder must impose a **deterministic total order** — page
 * boundaries are meaningless otherwise, and rows can repeat or vanish. Order by
 * a unique column, or by a non-unique one with `id` as a tiebreaker.
 */
export async function fetchAll<T>(
  build: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }> & {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
  pageSize = 1000
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchAll: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < pageSize) break;
    // A runaway guard, not a limit anyone should reach: a personal finance
    // install with a quarter of a million matching rows has a different problem.
    if (out.length >= 250_000) {
      console.error(`[fetchAll] stopped at ${out.length} rows — refusing to page further`);
      break;
    }
  }
  return out;
}

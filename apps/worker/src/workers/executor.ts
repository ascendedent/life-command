import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Executor — Phase 3 will implement guardrail-gated execution here:
 * consume *approved* recommendation rows only, re-validate every guardrail
 * from agent_config at execution time, then call Alpaca/Kalshi/Astra.
 *
 * Hard rules from the spec: only this worker touches execution APIs, and it
 * never calls the LLM. The recommendations table is the only bridge.
 */
export async function executorTick(_db: SupabaseClient) {
  // Phase 0: nothing to execute; autonomy is locked at level 0.
}

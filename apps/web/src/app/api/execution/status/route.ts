import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";
import {
  alpacaConfigured,
  executionReadiness,
  getAccount,
  listPositions,
  type ExecutionMode,
} from "@finance/shared";

/**
 * Is execution actually armed, and if not, which switch is off?
 *
 * The worker answers this for itself every run and logs the reason, which is
 * useless to someone looking at a page. Trading is opt-in at five independent
 * points and four of them being on looks exactly like none of them being on —
 * so the page has to name the one that is off.
 *
 * A route rather than a query because two of the five only exist server-side:
 * the API keys are not in the browser's environment and never should be, and
 * whether the broker answers is not a fact the database holds.
 */
export async function GET() {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const [{ data: cfg }, { data: flagged }, { data: candidates }] = await Promise.all([
    supabase.from("agent_config").select("*").eq("id", 1).maybeSingle(),
    supabase.from("accounts").select("id, name, mask, type").eq("is_agent_controlled", true),
    supabase
      .from("accounts")
      .select("id, name, mask, type, provider, is_agent_controlled")
      .eq("type", "investment")
      .order("name"),
  ]);

  const allowed: string[] = cfg?.allowed_action_types ?? [];
  const mode: ExecutionMode = cfg?.execution_mode === "live" ? "live" : "paper";

  // Shared with the worker so the page and the agent cannot drift into
  // disagreeing about what "armed" means.
  const readiness = executionReadiness({
    config: cfg
      ? {
          autonomy_level: Number(cfg.autonomy_level ?? 0),
          max_txn_amount: Number(cfg.max_txn_amount ?? 0),
          max_daily_amount: Number(cfg.max_daily_amount ?? 0),
          max_position_size: Number(cfg.max_position_size ?? 0),
          max_open_positions: Number(cfg.max_open_positions ?? 0),
          allowed_action_types: allowed,
        }
      : null,
    flagged: (flagged ?? []).map((a) => ({ name: a.name, mask: a.mask })),
    brokerConfigured: alpacaConfigured(),
  });

  // Only worth asking the broker once the keys exist. An unreachable broker is
  // reported as its own failure rather than folded into the keys check, because
  // "wrong keys" and "Alpaca is down" want different responses from the owner.
  let broker: Record<string, unknown> | null = null;
  let brokerError: string | null = null;
  if (alpacaConfigured()) {
    try {
      const [account, positions] = await Promise.all([getAccount(mode), listPositions(mode)]);
      broker = {
        mode,
        status: account.status,
        cash: Number(account.cash),
        equity: Number(account.equity),
        buying_power: Number(account.buying_power),
        positions: positions.map((p) => ({
          symbol: p.symbol,
          qty: Number(p.qty),
          market_value: Number(p.market_value),
          unrealized_pl: Number(p.unrealized_pl),
        })),
      };
    } catch (e: unknown) {
      brokerError = (e as Error).message;
    }
  }

  return NextResponse.json({
    canPropose: readiness.canPropose && !brokerError,
    canExecute: readiness.canExecute && !brokerError,
    autonomy_level: Number(cfg?.autonomy_level ?? 0),
    mode,
    allowed_action_types: allowed,
    checks: readiness.checks,
    broker,
    brokerError,
    candidates: candidates ?? [],
  });
}

/**
 * Create (or refresh) the account row the broker's orders land in.
 *
 * Alpaca is not a bank Plaid aggregates, so this account cannot arrive through
 * the sync that produces every other row in the table — and without it there is
 * nothing to flag agent-controlled and nothing for an order to reference. The
 * broker is asked who it is rather than the owner being asked to type it in.
 */
export async function POST() {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  if (!alpacaConfigured()) {
    return NextResponse.json({ error: "Alpaca is not configured" }, { status: 400 });
  }

  const { data: cfg } = await supabase
    .from("agent_config")
    .select("execution_mode")
    .eq("id", 1)
    .maybeSingle();
  const mode: ExecutionMode = cfg?.execution_mode === "live" ? "live" : "paper";

  let account;
  try {
    account = await getAccount(mode);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // Keyed on the broker's own id, so pressing this twice refreshes one row
  // instead of creating a second account nobody asked for — and two eligible
  // accounts would disable trading rather than merely look untidy.
  const { data: row, error } = await supabase
    .from("accounts")
    .upsert(
      {
        provider: "alpaca",
        external_account_id: account.id,
        name: mode === "live" ? "Alpaca" : "Alpaca Paper",
        type: "investment",
        subtype: "brokerage",
        mask: account.id.slice(-4),
        current_balance: Number(account.equity),
        available_balance: Number(account.cash),
      },
      { onConflict: "provider,external_account_id" }
    )
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Naming one unnames the rest — the agent must never pick between accounts.
  await supabase
    .from("accounts")
    .update({ is_agent_controlled: false })
    .eq("is_agent_controlled", true)
    .neq("id", row.id);
  await supabase.from("accounts").update({ is_agent_controlled: true }).eq("id", row.id);

  await supabase.from("audit_log").insert({
    actor: "user",
    action: "broker_account_linked",
    entity: "accounts",
    entity_id: row.id,
    detail: { provider: "alpaca", mode },
  });

  return NextResponse.json({ id: row.id });
}

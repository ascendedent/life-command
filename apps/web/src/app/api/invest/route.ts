import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";
import {
  alpacaConfigured,
  getAccount,
  listOrders,
  listPositions,
  type ExecutionMode,
} from "@finance/shared";

/**
 * Everything the Investments page shows.
 *
 * Positions and orders come from the broker rather than our tables, because
 * the broker is the only thing that knows whether an order filled and what a
 * position is worth right now. Our own `executions` rows are shown beside them
 * and answer a different question — what this platform asked for, including the
 * orders its guardrails refused, which the broker never heard about at all.
 */
export async function GET() {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const { data: cfg } = await supabase
    .from("agent_config")
    .select("execution_mode")
    .eq("id", 1)
    .maybeSingle();
  const mode: ExecutionMode = cfg?.execution_mode === "live" ? "live" : "paper";

  const { data: executions } = await supabase
    .from("executions")
    .select("id, created_at, mode, action, request, outcome, violations, broker_order_id, error, recommendations (summary)")
    .order("created_at", { ascending: false })
    .limit(25);

  if (!alpacaConfigured()) {
    return NextResponse.json({
      configured: false,
      mode,
      account: null,
      positions: [],
      orders: [],
      executions: executions ?? [],
      error: null,
    });
  }

  try {
    const [account, positions, orders] = await Promise.all([
      getAccount(mode),
      listPositions(mode),
      listOrders(mode),
    ]);
    return NextResponse.json({
      configured: true,
      mode,
      account: {
        status: account.status,
        cash: Number(account.cash),
        equity: Number(account.equity),
        buying_power: Number(account.buying_power),
        pattern_day_trader: account.pattern_day_trader,
      },
      positions: positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        qty: Number(p.qty),
        avg_entry_price: Number(p.avg_entry_price),
        current_price: Number(p.current_price),
        market_value: Number(p.market_value),
        cost_basis: Number(p.cost_basis),
        unrealized_pl: Number(p.unrealized_pl),
        unrealized_plpc: Number(p.unrealized_plpc),
        change_today: Number(p.change_today),
      })),
      orders: orders.map((o) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty ? Number(o.qty) : null,
        notional: o.notional ? Number(o.notional) : null,
        filled_qty: o.filled_qty ? Number(o.filled_qty) : null,
        filled_avg_price: o.filled_avg_price ? Number(o.filled_avg_price) : null,
        type: o.type,
        status: o.status,
        submitted_at: o.submitted_at,
        // Every order this platform placed carries rec-<uuid>; anything else
        // was placed by hand at the broker, and saying so is more useful than
        // pretending the page is the only way in.
        from_platform: (o.client_order_id ?? "").startsWith("rec-"),
      })),
      executions: executions ?? [],
      error: null,
    });
  } catch (e: unknown) {
    return NextResponse.json({
      configured: true,
      mode,
      account: null,
      positions: [],
      orders: [],
      executions: executions ?? [],
      error: (e as Error).message,
    });
  }
}

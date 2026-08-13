// Alpaca client, paper by default (spec Phase 3a).
//
// Deliberately thin: the executor is the only caller, it passes an order that
// has already cleared the guardrails, and nothing here decides anything. Keys
// are read from the environment server-side and never reach the browser.

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";

export type ExecutionMode = "paper" | "live";

export interface AlpacaOrder {
  symbol: string;
  side: "buy" | "sell";
  /** Dollar-denominated order. Alpaca accepts notional for fractionable stock. */
  notional?: number;
  qty?: number;
  type: "market" | "limit";
  time_in_force: "day" | "gtc";
  limit_price?: number;
  client_order_id?: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  avg_entry_price: string;
  current_price: string;
  /** Today's move, as a fraction. Alpaca's own figure, not ours to derive. */
  change_today: string;
  asset_class: string;
  side: string;
}

export interface AlpacaOrderRecord {
  id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  qty: string | null;
  notional: string | null;
  filled_qty: string | null;
  filled_avg_price: string | null;
  type: string;
  time_in_force: string;
  status: string;
  submitted_at: string;
  filled_at: string | null;
}

export interface AlpacaAccount {
  id: string;
  status: string;
  cash: string;
  equity: string;
  buying_power: string;
  pattern_day_trader: boolean;
}

export class AlpacaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = "AlpacaError";
  }
}

export function alpacaConfigured(): boolean {
  return !!(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);
}

function headers(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID ?? "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY ?? "",
    "Content-Type": "application/json",
  };
}

function baseUrl(mode: ExecutionMode): string {
  // Live is reachable only when the owner has explicitly switched
  // agent_config.execution_mode; the default is paper and stays paper.
  if (mode === "live") return LIVE_BASE;
  // Paper only, and never live: the executor had never placed an order
  // anywhere, and "it works" should not first be tested with real keys against
  // a real venue. Pointing paper at a local stub exercises order placement,
  // idempotency and the daily cap without an account.
  return process.env.ALPACA_PAPER_BASE || PAPER_BASE;
}

async function call<T>(
  mode: ExecutionMode,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${baseUrl(mode)}${path}`, { ...init, headers: headers() });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw text — an HTML error page is worth seeing verbatim */
  }
  if (!res.ok) {
    const message =
      (body as { message?: string })?.message ?? `Alpaca ${path} failed: HTTP ${res.status}`;
    throw new AlpacaError(message, res.status, body);
  }
  return body as T;
}

export function getAccount(mode: ExecutionMode): Promise<AlpacaAccount> {
  return call<AlpacaAccount>(mode, "/v2/account");
}

export function listPositions(mode: ExecutionMode): Promise<AlpacaPosition[]> {
  return call<AlpacaPosition[]>(mode, "/v2/positions");
}

/** Latest trade price, used to value an order before the guardrails see it. */
export async function lastPrice(mode: ExecutionMode, symbol: string): Promise<number | null> {
  try {
    const data = await call<{ trade?: { p?: number } }>(
      mode,
      `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`
    );
    return data.trade?.p ?? null;
  } catch {
    return null;
  }
}

/**
 * Recent orders as the broker remembers them. Our `executions` table records
 * what we asked for; this records what happened to it — a fill, a rejection at
 * the venue, a cancellation we never initiated.
 */
export function listOrders(
  mode: ExecutionMode,
  limit = 25
): Promise<AlpacaOrderRecord[]> {
  return call<AlpacaOrderRecord[]>(
    mode,
    `/v2/orders?status=all&limit=${limit}&direction=desc`
  );
}

export function placeOrder(mode: ExecutionMode, order: AlpacaOrder): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(mode, "/v2/orders", {
    method: "POST",
    body: JSON.stringify(order),
  });
}

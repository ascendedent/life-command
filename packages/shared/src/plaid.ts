import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export interface PlaidErrorInfo {
  status: number | null;
  error_type: string | null;
  error_code: string | null;
  error_message: string | null;
  display_message: string | null;
  request_id: string | null;
  /** Human-readable one-liner suitable for a log or a UI banner. */
  summary: string;
}

/**
 * Pull the useful part out of a Plaid failure.
 *
 * The SDK is axios-based, so `error.message` is only ever "Request failed with
 * status code 400" — the diagnosis (error_code, error_message, request_id)
 * lives in the response body. Logging the axios message alone makes every
 * Plaid failure look identical and impossible to act on.
 */
export function plaidError(e: unknown): PlaidErrorInfo {
  const err = e as {
    message?: string;
    response?: { status?: number; data?: Record<string, unknown> };
  };
  const data = err?.response?.data ?? {};
  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : null);

  const code = str("error_code");
  const message = str("error_message");
  const summary = code
    ? `${code}${message ? `: ${message}` : ""}`
    : (err?.message ?? "unknown Plaid error");

  return {
    status: err?.response?.status ?? null,
    error_type: str("error_type"),
    error_code: code,
    error_message: message,
    display_message: str("display_message"),
    request_id: str("request_id"),
    summary,
  };
}

export function createPlaidClient(): PlaidApi {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV ?? "sandbox";
  if (!clientId || !secret) {
    throw new Error("Missing PLAID_CLIENT_ID / PLAID_SECRET");
  }
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
      },
    })
  );
}

// ---------------------------------------------------------------------------
// credit card APRs
// ---------------------------------------------------------------------------

export interface CardApr {
  apr_type: string;
  apr_percentage: number | null;
  balance_subject_to_apr: number | null;
  interest_charge_amount: number | null;
}

export interface AprSummary {
  purchase: number | null;
  cash: number | null;
  balance_transfer: number | null;
  /** Promotional or introductory rate, when the issuer reports one. */
  special: number | null;
  /**
   * The rate actually being paid on purchases. A promotion overrides the
   * headline purchase APR for as long as it lasts, and it is the difference
   * between carrying a balance being free and costing 27%.
   */
  effective: number | null;
  /** Interest the issuer says it charged on the last statement, if reported. */
  charged_last_statement: number | null;
}

const aprValue = (aprs: CardApr[], type: string): number | null => {
  const hit = aprs.find((a) => a.apr_type === type);
  return hit?.apr_percentage != null ? Number(hit.apr_percentage) : null;
};

/**
 * Read a card's APR array into the handful of numbers anything downstream
 * actually wants.
 *
 * Plaid reports four types and we stored one. Note `effective`: a card showing
 * `purchase_apr` of 24.99% while a `special` entry says 0% is not a 24.99%
 * card this month, and treating it as one overstates the cost of carrying it.
 */
export function summarizeAprs(aprs: CardApr[] | null | undefined): AprSummary {
  const list = aprs ?? [];
  const purchase = aprValue(list, "purchase_apr");
  const special = aprValue(list, "special");
  const charged = list
    .map((a) => (a.interest_charge_amount != null ? Number(a.interest_charge_amount) : null))
    .filter((n): n is number => n != null);
  return {
    purchase,
    cash: aprValue(list, "cash_apr"),
    balance_transfer: aprValue(list, "balance_transfer_apr"),
    special,
    effective: special ?? purchase,
    charged_last_statement: charged.length ? charged.reduce((s, n) => s + n, 0) : null,
  };
}

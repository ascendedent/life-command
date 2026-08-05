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

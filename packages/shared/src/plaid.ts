import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

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

#!/usr/bin/env node
// Pulls URLs/keys from the running local Supabase stack and writes the env
// files each app needs. Re-run any time after `supabase start`.
// Hosted migration later = swap these values for the hosted project's.

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const raw = execSync("npx supabase status -o env", {
  cwd: root,
  encoding: "utf8",
});

const vars = {};
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) vars[m[1]] = m[2];
}

const apiUrl = vars.API_URL;
const anonKey = vars.ANON_KEY ?? vars.PUBLISHABLE_KEY;
const serviceKey = vars.SERVICE_ROLE_KEY ?? vars.SECRET_KEY;
const dbUrl = vars.DB_URL;

if (!apiUrl || !anonKey || !serviceKey) {
  console.error("Could not read Supabase status — is the stack running? (npm run db:start)");
  process.exit(1);
}

// Web env: NEXT_PUBLIC_* reach the browser; everything else stays
// server-side in API routes/server components (Next never ships plain env
// vars to the client). Plaid keys + encryption key are needed by the
// link-token/exchange routes; the service key by the SI ingest route.
const rootEnvRaw = existsSync(resolve(root, ".env"))
  ? readFileSync(resolve(root, ".env"), "utf8")
  : "";
const rootVars = {};
for (const line of rootEnvRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) rootVars[m[1]] = m[2];
}
const mirror = [
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_ENV",
  "APP_ENCRYPTION_KEY",
  "SI_API_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  // The Execution card asks the broker who it is and whether the keys work, so
  // the web process needs them too. The worker reads the root .env directly and
  // would have been fine either way — which is how this hides: trading looks
  // configured everywhere except the one page that reports whether it is.
  "ALPACA_KEY_ID",
  "ALPACA_SECRET_KEY",
];
writeFileSync(
  resolve(root, "apps/web/.env.local"),
  [
    `NEXT_PUBLIC_SUPABASE_URL=${apiUrl}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
    ...mirror.filter((k) => rootVars[k]).map((k) => `${k}=${rootVars[k]}`),
    "",
  ].join("\n")
);

// Server-side worker secrets. Never imported by browser code.
writeFileSync(
  resolve(root, "apps/worker/.env"),
  [
    `SUPABASE_URL=${apiUrl}`,
    `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
    `DATABASE_URL=${dbUrl ?? ""}`,
    "",
  ].join("\n")
);

// Root .env for scripts (create-owner etc.). Preserve any extra lines the
// user added (e.g. OWNER_EMAIL, future API keys).
const rootEnvPath = resolve(root, ".env");
const managed = new Set(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]);
let extra = [];
if (existsSync(rootEnvPath)) {
  extra = readFileSync(rootEnvPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !managed.has(l.split("=")[0]));
}
writeFileSync(
  rootEnvPath,
  [
    `SUPABASE_URL=${apiUrl}`,
    `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
    `DATABASE_URL=${dbUrl ?? ""}`,
    ...extra,
    "",
  ].join("\n")
);

console.log("Wrote apps/web/.env.local, apps/worker/.env, .env");

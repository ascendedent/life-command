#!/usr/bin/env node
/**
 * Re-attach Plaid Items from a support-issued access_token export.
 *
 * Plaid does not let you retrieve an access_token after issuance, so when the
 * database holding them was lost, nine linked institutions looked permanently
 * gone — re-linking would have minted nine *new* Items against a 10-Item Trial
 * cap that does not release the old ones. Plaid Support can export the tokens
 * on request, which turns an unrecoverable loss into an import.
 *
 * The tokens never pass through a terminal or a log. This reads the CSV, asks
 * Plaid who each token belongs to, encrypts it with APP_ENCRYPTION_KEY and
 * writes it straight to the database. Everything printed is masked.
 *
 *   node scripts/import-plaid-tokens.mjs <path-to-csv> [--dry-run]
 *
 * Expected columns: access_token, env, item_id (the rest are ignored).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(ROOT, "apps/worker/.env") });
loadEnv({ path: resolve(ROOT, ".env") });

const { createServiceClient, createPlaidClient, encryptSecret, audit } = await import(
  "@finance/shared"
);

const csvPath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const allEnvs = process.argv.includes("--all-envs");
if (!csvPath) {
  console.error("usage: node scripts/import-plaid-tokens.mjs <csv> [--dry-run]");
  process.exit(1);
}

const log = (m) => console.log(`[import] ${m}`);
const mask = (id) => `…${String(id).slice(-8)}`;

// Minimal CSV parse: this file comes from Plaid with no embedded commas or
// quoting in any field we read.
const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const header = lines[0].split(",").map((h) => h.trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`CSV is missing a "${name}" column`);
  return i;
};
const [iTok, iEnv, iItem] = [col("access_token"), col("env"), col("item_id")];

// The export is an event log — one row per product added — so the same Item
// appears several times. And it spans environments: only the ones matching
// PLAID_ENV are usable, because a token is scoped to the environment that
// issued it.
const wantEnv = (process.env.PLAID_ENV || "production").toLowerCase();
const byItem = new Map();
const envOf = new Map();
let skippedEnv = 0;
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const f = line.split(",");
  const env = (f[iEnv] || "").trim().toLowerCase();
  // --all-envs ignores the export's env label and lets the liveness check
  // decide. Plaid's naming does not line up with PLAID_ENV: on this export,
  // five of the nine working production Items were labelled "pre-prod", and
  // trusting the column would have thrown away more than half of them. A token
  // that authenticates against the configured environment is usable whatever
  // the spreadsheet calls it, and one that does not fails at itemGet below
  // rather than being written in to fail on every sync afterwards.
  if (env !== wantEnv && !allEnvs) {
    skippedEnv++;
    continue;
  }
  const itemId = (f[iItem] || "").trim();
  const token = (f[iTok] || "").trim();
  if (!itemId || !token) continue;
  byItem.set(itemId, token);
  if (allEnvs) envOf.set(itemId, env);
}

log(`${lines.length - 1} row(s) in the export`);
log(`${skippedEnv} row(s) skipped — not PLAID_ENV=${wantEnv}`);
log(`${byItem.size} distinct Item(s) to import`);
if (!byItem.size) {
  console.error(`[import] nothing matched env=${wantEnv} — check PLAID_ENV`);
  process.exit(1);
}

const db = createServiceClient();
const plaid = createPlaidClient();

let ok = 0;
const failures = [];
for (const [itemId, token] of byItem) {
  let instId = null;
  let instName = "Institution";
  try {
    // Asking Plaid who this token belongs to doubles as a liveness check: a
    // revoked or wrong-environment token fails here rather than being written
    // into the database to fail silently on every sync afterwards.
    const item = await plaid.itemGet({ access_token: token });
    instId = item.data.item.institution_id ?? null;
    if (instId) {
      const inst = await plaid.institutionsGetById({
        institution_id: instId,
        country_codes: ["US"],
      });
      instName = inst.data.institution.name;
    }
  } catch (e) {
    const msg = e?.response?.data?.error_code || e.message;
    failures.push({ itemId, msg });
    console.error(`[import] ${mask(itemId)}: FAILED — ${msg}`);
    continue;
  }

  if (dryRun) {
    log(`would import ${instName} (${mask(itemId)})${allEnvs ? `  [labelled ${envOf.get(itemId)}]` : ""}`);
    ok++;
    continue;
  }

  const { error } = await db.from("institutions").upsert(
    {
      plaid_item_id: itemId,
      plaid_institution_id: instId,
      name: instName,
      status: "ok",
      access_token_enc: encryptSecret(token),
    },
    { onConflict: "plaid_item_id" }
  );
  if (error) {
    failures.push({ itemId, msg: error.message });
    console.error(`[import] ${mask(itemId)}: insert failed — ${error.message}`);
    continue;
  }
  log(`imported ${instName} (${mask(itemId)})`);
  ok++;
}

if (!dryRun && ok) {
  await audit(db, "user", "plaid_tokens_imported", "institutions", undefined, {
    imported: ok,
    failed: failures.length,
    source: "plaid support export",
  });
}

log(`${ok} imported, ${failures.length} failed`);
if (failures.length) {
  log("failed Items (masked):");
  for (const f of failures) log(`  ${mask(f.itemId)} — ${f.msg}`);
}
log(dryRun ? "dry run — nothing written" : "next: npm run svc:start, then a full sync");

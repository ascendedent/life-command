#!/usr/bin/env node
/**
 * Put a dump back.
 *
 * Written at the same time as the backup, on purpose. An untested restore path
 * is how a directory full of dumps turns out to be a directory full of files —
 * the failure only shows up on the day it is the only thing left, which is
 * exactly the day it must not.
 *
 *   npm run db:restore            # newest dump, after confirmation
 *   npm run db:restore -- --list  # show what is available
 *   npm run db:restore -- <file>  # a specific dump
 *   npm run db:restore -- --yes   # skip the confirmation (for scripts)
 */
import { execFileSync, execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST =
  process.env.BACKUP_DIR || join(dirname(ROOT), "Supabase Backup - Finance Dashboard");
const CONTAINER = process.env.SUPABASE_DB_CONTAINER || "supabase_db_Finance_Dashboard";
const args = process.argv.slice(2);
const log = (m) => console.log(`[restore] ${m}`);

const dumps = existsSync(DEST)
  ? readdirSync(DEST)
      .filter((f) => /^finance_full_\d{8}_\d{6}\.dump$/.test(f))
      .sort()
      .reverse()
  : [];

if (args.includes("--list") || !dumps.length) {
  if (!dumps.length) {
    console.error(`[restore] no dumps in ${DEST}`);
    process.exit(1);
  }
  log(`${dumps.length} dump(s) in ${DEST}:`);
  for (const d of dumps) {
    const mb = (statSync(join(DEST, d)).size / 1048576).toFixed(1);
    const logFile = join(DEST, d.replace(/\.dump$/, ".log"));
    const rows = existsSync(logFile)
      ? execSync(`grep -A20 'row counts' ${JSON.stringify(logFile)} | grep transactions || true`, {
          encoding: "utf8", shell: "/bin/bash",
        }).trim()
      : "";
    log(`  ${d}  ${mb} MB  ${rows}`);
  }
  process.exit(0);
}

const chosen = args.find((a) => a.endsWith(".dump")) || dumps[0];
const dumpPath = chosen.includes("/") ? chosen : join(DEST, chosen);
if (!existsSync(dumpPath)) {
  console.error(`[restore] not found: ${dumpPath}`);
  process.exit(1);
}

try {
  const running = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], {
    encoding: "utf8",
  }).trim();
  if (running !== "true") throw new Error("not running");
} catch {
  console.error(`[restore] ${CONTAINER} is not running — start the stack first (npm run db:start)`);
  process.exit(1);
}

const current = execSync(
  `docker exec ${CONTAINER} psql -U postgres -d postgres -At -c "select count(*) from transactions" 2>/dev/null || echo 0`,
  { encoding: "utf8", shell: "/bin/bash" }
).trim();

if (!args.includes("--yes")) {
  // --clean drops what is there. Saying so out loud, with the number that is
  // about to be replaced, is the difference between a restore and an accident.
  console.log(
    `\nAbout to restore ${chosen} into ${CONTAINER}.\n` +
      `This DROPS the current contents — the database currently holds ${current} transactions.\n`
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type 'restore' to proceed: ");
  rl.close();
  if (answer.trim() !== "restore") {
    log("aborted — nothing was changed");
    process.exit(1);
  }
}

// `pg_dump --schema=public` dumps the schema's *contents* and assumes the schema
// itself is there — it emits no CREATE SCHEMA. Restoring into a database whose
// public schema is gone (a fresh container, or the actual disaster this exists
// for) fails on every single object with "schema public does not exist".
//
// Found by dropping the schema and trying it, which is the only test that
// counts: restoring over a healthy database exercises none of this.
log("ensuring the public schema exists");
execSync(
  `docker exec ${CONTAINER} psql -U postgres -d postgres -c ` +
    `"create schema if not exists public; ` +
    `grant usage on schema public to postgres, anon, authenticated, service_role; ` +
    `grant create on schema public to postgres;"`,
  { stdio: ["ignore", "ignore", "ignore"], shell: "/bin/bash" }
);

log(`restoring ${chosen}`);
try {
  execSync(
    `docker exec -i ${CONTAINER} pg_restore -U postgres -d postgres --clean --if-exists --no-owner < ${JSON.stringify(dumpPath)}`,
    { stdio: ["ignore", "ignore", "pipe"], shell: "/bin/bash" }
  );
} catch (e) {
  // Supabase owns four event triggers as `supabase_admin`, so restoring as
  // `postgres` always fails to drop them. Those four lines appear on every
  // healthy restore, and printing them as "issues" teaches you to skim past the
  // output — which is where a real failure would then hide. Filtered by name,
  // and anything else is surfaced loudly.
  // With a public-only dump there is nothing a restore legitimately fails on,
  // so the filter is narrow on purpose: the event triggers Supabase attaches to
  // the public schema are the only expected noise. Everything else is real.
  // Two kinds of expected noise, both from objects Supabase owns as
  // `supabase_admin`: its event triggers on the public schema, and the default
  // privileges it sets there. Neither affects the restored data, and both appear
  // on every healthy restore. Everything else is real and gets shouted about.
  const EXPECTED = new RegExp(
    "must be owner of event trigger (pgrst_drop_watch|pgrst_ddl_watch|issue_pg_net_access" +
      "|issue_pg_graphql_access|issue_pg_cron_access|issue_graphql_placeholder)" +
      "|permission denied to change default privileges"
  );
  const lines = String(e.stderr || e.message).split("\n").filter((l) => l.trim());
  const real = lines.filter((l) => l.includes("error:") && !EXPECTED.test(l));
  if (real.length) {
    log(`pg_restore reported ${real.length} unexpected error(s):`);
    for (const l of real.slice(0, 10)) console.log(`  ${l}`);
  } else {
    log(`pg_restore finished (${lines.length} expected ownership notices suppressed)`);
  }
}

const storageTar = dumpPath.replace(/\.dump$/, ".storage.tar.gz");
if (existsSync(storageTar)) {
  const VOL = process.env.SUPABASE_STORAGE_VOLUME || "supabase_storage_Finance_Dashboard";
  try {
    execSync(`docker run --rm -i -v ${VOL}:/s alpine tar xzf - -C /s < ${JSON.stringify(storageTar)}`,
      { stdio: ["ignore", "ignore", "ignore"], shell: "/bin/bash" });
    log("storage bucket restored");
  } catch (e) {
    log(`WARN: storage restore failed — ${String(e.message).slice(0, 120)}`);
  }
}

const after = execSync(
  `docker exec ${CONTAINER} psql -U postgres -d postgres -At -F'|' -c ` +
    `"select 'transactions', count(*) from transactions union all ` +
    `select 'accounts', count(*) from accounts union all ` +
    `select 'institutions', count(*) from institutions;"`,
  { encoding: "utf8", shell: "/bin/bash" }
).trim();
log("after restore:");
for (const line of after.split("\n")) log(`  ${line.replace("|", ": ")}`);
log("run `npx supabase migration up` if the dump predates the current migrations");

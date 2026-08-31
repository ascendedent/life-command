#!/usr/bin/env node
/**
 * Dump the database somewhere the existing off-machine sync will carry it.
 *
 * The platform already had a backup system — rclone bisync of ~/projects to
 * Drive — and it never covered the one thing that mattered. Postgres lived in a
 * Docker volume on a disk called "scratch", outside every synced path, and when
 * that disk was cleared on 2026-08-29 it took 2,943 transactions, nine linked
 * institutions and months of categorisation with it. The repo, the .env and the
 * encryption key all survived; only the data did not.
 *
 * So this does not add a new backup mechanism. It puts the database inside the
 * one that already works, using the same shape as the hand-made Ops Hub dump
 * sitting one directory over.
 *
 * Deliberately writes OUTSIDE the repo — a sibling directory under ~/projects.
 * The dump contains real balances and merchant names, and the repo is public;
 * a gitignore entry is one `git add -f` away from a very bad afternoon.
 * Sitting outside the working tree, it cannot be committed by accident, and
 * rclone picks it up regardless because it syncs the filesystem, not git.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST =
  process.env.BACKUP_DIR || join(dirname(ROOT), "Supabase Backup - Finance Dashboard");
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const CONTAINER = process.env.SUPABASE_DB_CONTAINER || "supabase_db_Finance_Dashboard";

// Local time, not UTC — it has to line up with the timer that fired it and with
// the dump names already in the neighbouring project directory, or comparing two
// backups means doing timezone arithmetic in your head at the worst moment.
const now = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const stamp =
  `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
  `_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const base = `finance_full_${stamp}`;

const log = (m) => console.log(`[backup] ${m}`);

function containerRunning() {
  try {
    return (
      execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], {
        encoding: "utf8",
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

if (!containerRunning()) {
  // Failing loudly beats writing a zero-byte file that looks like a backup.
  console.error(
    `[backup] FAILED: container ${CONTAINER} is not running — nothing was written`
  );
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });
const dumpPath = join(DEST, `${base}.dump`);
const tocPath = join(DEST, `${base}.toc.txt`);
const logPath = join(DEST, `${base}.log`);

log(`dumping ${CONTAINER} -> ${dumpPath}`);
try {
  // `--schema=public` only, and this is the important part.
  //
  // A whole-database dump also carries Supabase's own schemas — auth, storage,
  // graphql, realtime, vector — every one of them owned by `supabase_admin`.
  // Restoring as `postgres` cannot touch them, so a full dump restores with
  // ~715 ownership errors while the application tables quietly succeed. The
  // first version of this script did exactly that: the verification marker came
  // back, the restore "worked", and the noise would have hidden a genuine
  // failure perfectly.
  //
  // `public` is the entire application. What it leaves behind is the owner's
  // login, recreated in two minutes with `npm run owner:create` plus
  // re-enrolling the authenticator — a far better trade than a dump that cannot
  // be restored cleanly.
  //
  // ACLs are kept. `--no-acl` looks like a companion to `--no-owner` and is not:
  // it strips every GRANT, and this schema hands explicit DML to `authenticated`
  // on every table. A restore without them produces a database with correct rows,
  // correct RLS, and an application that cannot read a single one of them.
  //
  // -Fc is the custom format: compressed, and restorable selectively with
  // pg_restore, which matters when you want one table back rather than all of it.
  execSync(
    `docker exec ${CONTAINER} pg_dump -U postgres -d postgres -Fc --schema=public --no-owner > ${JSON.stringify(dumpPath)}`,
    { stdio: ["ignore", "ignore", "pipe"], shell: "/bin/bash" }
  );
} catch (e) {
  console.error(`[backup] FAILED: pg_dump errored — ${String(e.stderr || e.message).slice(0, 400)}`);
  try { if (existsSync(dumpPath)) unlinkSync(dumpPath); } catch {}
  process.exit(1);
}

const size = statSync(dumpPath).size;
if (size < 1024) {
  console.error(`[backup] FAILED: dump is ${size} bytes — refusing to keep it`);
  unlinkSync(dumpPath);
  process.exit(1);
}

// A table of contents beside the dump, so a future reader can see what is in it
// without a running Postgres to restore into.
try {
  execSync(`docker exec -i ${CONTAINER} pg_restore -l < ${JSON.stringify(dumpPath)} > ${JSON.stringify(tocPath)}`, {
    stdio: ["ignore", "ignore", "ignore"],
    shell: "/bin/bash",
  });
} catch {
  log("WARN: could not write table of contents (dump is still valid)");
}

// Row counts for the tables worth noticing. A dump that restores cleanly and
// contains nothing is the failure mode this whole exercise exists to prevent,
// and a size in megabytes does not distinguish the two.
let counts = "";
try {
  counts = execSync(
    `docker exec ${CONTAINER} psql -U postgres -d postgres -At -F'|' -c ` +
      `"select 'transactions', count(*) from transactions union all ` +
      `select 'accounts', count(*) from accounts union all ` +
      `select 'institutions', count(*) from institutions union all ` +
      `select 'recurring_items', count(*) from recurring_items union all ` +
      `select 'goals', count(*) from goals union all ` +
      `select 'merchant_map', count(*) from merchant_map union all ` +
      `select 'email_receipts', count(*) from email_receipts;"`,
    { encoding: "utf8", shell: "/bin/bash" }
  );
} catch {
  counts = "(row counts unavailable)";
}

writeFileSync(
  logPath,
  [
    `taken_at: ${new Date().toISOString()}`,
    `container: ${CONTAINER}`,
    `dump: ${base}.dump`,
    `bytes: ${size}`,
    "",
    "row counts at time of dump:",
    counts.trim(),
    "",
    "restore into a running local stack with:",
    `  docker exec -i ${CONTAINER} pg_restore -U postgres -d postgres --clean --if-exists < ${base}.dump`,
    "",
  ].join("\n")
);

log(`wrote ${(size / 1048576).toFixed(1)} MB`);
for (const line of counts.trim().split("\n")) log(`  ${line.replace("|", ": ")}`);

// Receipt files live in the Storage bucket, not in Postgres — the database
// only holds the path. A dump without them restores rows pointing at nothing,
// so the bucket rides along whenever it has contents.
const STORAGE_VOLUME = process.env.SUPABASE_STORAGE_VOLUME || "supabase_storage_Finance_Dashboard";
try {
  const files = execSync(
    `docker run --rm -v ${STORAGE_VOLUME}:/s alpine sh -c 'find /s -type f | wc -l'`,
    { encoding: "utf8", shell: "/bin/bash" }
  ).trim();
  if (Number(files) > 0) {
    const tarPath = join(DEST, `${base}.storage.tar.gz`);
    execSync(
      `docker run --rm -v ${STORAGE_VOLUME}:/s alpine tar czf - -C /s . > ${JSON.stringify(tarPath)}`,
      { stdio: ["ignore", "ignore", "ignore"], shell: "/bin/bash" }
    );
    log(`storage bucket: ${files} file(s) -> ${(statSync(tarPath).size / 1048576).toFixed(1)} MB`);
  } else {
    log("storage bucket is empty — nothing to archive");
  }
} catch (e) {
  log(`WARN: could not archive the storage bucket — ${String(e.message).slice(0, 120)}`);
}

// Retention: keep the last N sets. Pruning matters because bisync carries every
// file to Drive, and an unbounded pile of 150 MB dumps is its own outage.
const sets = readdirSync(DEST)
  .filter((f) => /^finance_full_\d{8}_\d{6}\.dump$/.test(f))
  .sort()
  .reverse();
for (const stale of sets.slice(KEEP)) {
  const prefix = stale.replace(/\.dump$/, "");
  for (const ext of [".dump", ".toc.txt", ".log", ".storage.tar.gz"]) {
    const p = join(DEST, prefix + ext);
    if (existsSync(p)) unlinkSync(p);
  }
  log(`pruned ${prefix}`);
}

log(`${Math.min(sets.length, KEEP)} backup(s) retained in ${DEST}`);
log("rclone bisync carries this to Drive on its next run");

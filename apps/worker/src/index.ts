import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// Load apps/worker/.env first, then fall back to repo-root .env (Plaid keys,
// APP_ENCRYPTION_KEY live in the root file).
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(here, "../.env") });
loadEnv({ path: resolve(repoRoot, ".env") });

const { default: cron } = await import("node-cron");
const { createServiceClient, createPlaidClient, audit } = await import("@finance/shared");
const { beat, markStopped } = await import("./heartbeat.js");
const { runSync, pollSyncJobs } = await import("./workers/sync.js");
const { detectRecurring } = await import("./workers/recurring.js");
const { snapshotNetWorth } = await import("./workers/networth.js");
const { startSiWatcher } = await import("./workers/si-watch.js");
const { agentTick } = await import("./workers/agent.js");
const { executorTick } = await import("./workers/executor.js");
const { pollGmail, expireAnticipations } = await import("./workers/gmail.js");
const { matchGoalContributions } = await import("./workers/goals.js");
const { runEnrichment } = await import("./workers/enrich.js");
const { runRecap } = await import("./workers/recap.js");
const { detectCardPayments } = await import("./workers/card-payments.js");

const db = createServiceClient();
const plaid = createPlaidClient();
const WORKERS = ["sync", "agent", "executor"] as const;

console.log("[worker] finance workers starting (phase 1)");

await beat(db, "sync", "ok", { note: "phase 1 sync live", booted: true });
await beat(db, "agent", "stub", { note: "phase 2", booted: true });
await beat(db, "executor", "stub", { note: "phase 3", booted: true });
await audit(db, "system", "worker_boot", "worker_heartbeats", undefined, {
  workers: [...WORKERS],
  pid: process.pid,
});

// Health heartbeat every 30s — the Overview page flags anything >2min stale.
cron.schedule("*/30 * * * * *", async () => {
  await beat(db, "sync", "ok");
  await beat(db, "agent", "stub");
  await beat(db, "executor", "stub");
});

// Plaid sync: every 6h (local-first polling; webhooks arrive at hosted migration)
cron.schedule("0 0 */6 * * *", () => {
  runSync(db, plaid).catch((e) => console.error("[sync] cron failed:", e.message));
});

// UI-triggered sync jobs: poll every 20s
let jobRunning = false;
cron.schedule("*/20 * * * * *", async () => {
  if (jobRunning) return;
  jobRunning = true;
  try {
    await pollSyncJobs(db, plaid);
  } catch (e: unknown) {
    console.error("[sync] job poll failed:", (e as Error).message);
  } finally {
    jobRunning = false;
  }
});

// Daily 02:00 — recurring detection + net worth snapshot + anticipation expiry
// + goal contribution matching (after recurring so links to new items resolve)
cron.schedule("0 0 2 * * *", async () => {
  try {
    await detectRecurring(db);
    await snapshotNetWorth(db);
    await expireAnticipations(db);
    await matchGoalContributions(db);
    await detectCardPayments(db, { apply: true, sinceDays: 60 });
  } catch (e: unknown) {
    console.error("[daily] failed:", (e as Error).message);
  }
});

// Gmail receipt ingestion: tight loop while local (spec §1.7.9)
let gmailRunning = false;
cron.schedule("*/45 * * * * *", async () => {
  if (gmailRunning) return;
  gmailRunning = true;
  try {
    await pollGmail(db);
  } catch (e: unknown) {
    console.error("[gmail] poll failed:", (e as Error).message);
  } finally {
    gmailRunning = false;
  }
});

// Daily 05:30 — LLM enrichment (categorization + business suggestions), ahead
// of the 06:00 agent run so the agent analyzes a fully categorized book.
cron.schedule("0 30 5 * * *", () => {
  runEnrichment(db).catch((e) => console.error("[enrich] cron failed:", e.message));
});

// Weekly recap: Sunday 22:00, covering the week that just ended.
cron.schedule("0 0 22 * * 0", () => {
  runRecap(db, "weekly").catch((e) => console.error("[recap] weekly failed:", e.message));
});

// Monthly recap: 1st at 03:00 — rolls up the weeklies and reviews subscriptions.
cron.schedule("0 0 3 1 * *", () => {
  runRecap(db, "monthly").catch((e) => console.error("[recap] monthly failed:", e.message));
});

// Phase stubs
cron.schedule("0 0 6 * * *", () => agentTick(db));
cron.schedule("0 * * * * *", () => executorTick(db));

// Self Improvement drop-folder watcher
startSiWatcher(db, repoRoot);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, marking workers stopped`);
  try {
    for (const name of WORKERS) await markStopped(db, name);
    await audit(db, "system", "worker_shutdown", "worker_heartbeats", undefined, {
      signal,
    });
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(
  "[worker] schedules registered: sync 6h, jobs 20s, gmail 45s, daily 02:00, enrich 05:30, " +
    "agent 06:00, recap weekly Sun 22:00, recap monthly 1st 03:00, heartbeat 30s"
);

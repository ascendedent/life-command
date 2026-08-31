# Personal AI Finance Platform

Self-hosted AI accountant: aggregates accounts, tracks goals, surfaces
recommendations, and graduates from read-only analysis to human-approved
execution to bounded autonomy. Full design in
[ai-finance-platform-spec.md](./ai-finance-platform-spec.md).

**Status: Phase 2 complete and running on real data. Phase 3a (approval-gated
paper trading) is built and waiting on broker keys.** Local-only, zero hosting
cost. Plaid production access is approved. Gmail receipt ingestion is live on
real mail.

> **License: [PolyForm Noncommercial 1.0.0](./LICENSE).** Use it, change it,
> run it for your own household, share it — commercial use is not granted.
> You may not sell it, resell it, or run it as a paid service. This is not an
> OSI-approved open-source licence, and that is deliberate.

> This is one person's self-hosted build, shared as-is. It assumes a single
> owner and a local Supabase stack — there is no multi-tenancy anywhere and
> none is planned. Everything instance-specific lives in `.env`; see
> [Environment keys](#environment-keys). `docs/` carries the security and
> data-retention policies Plaid's questionnaire asks for, as templates with
> `<OWNER NAME>` placeholders — fill them in and generate your own PDFs.

> **No personal data in this repository, ever.** A `pre-commit` hook
> (`scripts/hooks/pre-commit`, wired via `core.hooksPath`) blocks staged
> secrets, email addresses, long account/reference numbers, and anything listed
> in a gitignored `.pii-denylist`. Examples in comments are invented on
> purpose. See [Keeping personal data out](#keeping-personal-data-out).

## What exists now

- **Monorepo:** `apps/web` (Next.js 14 App Router), `apps/worker` (node-cron
  workers), `packages/shared` (DB client, Plaid client, token crypto,
  categorization engine).
- **Database:** Supabase local stack (Docker, Postgres 17) with the complete
  spec §4 schema — 40+ tables covering accounts, transactions, categorization,
  email receipts/anticipation, goals with cost attribution, recaps, the
  recommendation queue, agent config, self-improvement, and safety tables.
  RLS locks every row to the single allow-listed owner; `audit_log` is
  append-only (enforced by trigger, even against the service role).
- **Auth:** single owner account, password + mandatory TOTP 2FA (enrollment
  forced on first login). Public signup disabled at the auth server. The
  `/account` page (click your email in the sidebar) has in-app password
  change (TOTP-gated), the **auto-lock cadence** (fresh TOTP demanded when the
  last one is older than the setting, default 1 hour), and Gmail connections.
- **Network posture:** web app binds 127.0.0.1 only; Docker publishes all
  Supabase ports on 127.0.0.1 (`scripts/harden-docker-loopback.sh`, already
  applied). Nothing is reachable from the LAN.
- **Banking (Phase 1):** Plaid Link with encrypted access tokens, 6-hour sync
  of transactions/balances/holdings/liabilities, the categorization pipeline
  (rules → merchant map → Plaid baseline → review inbox), recurring detection,
  business layer, and net-worth snapshots.
- **Receipts (Phase 2):** multi-mailbox Gmail ingestion with per-inbox label
  mapping, LLM parse fallback, the anticipation engine, scored reconciliation,
  and the vendor watchlist — see Phase 2 notes.
- **The agent (Phase 2/3a):** daily analysis run on `claude-sonnet-5` producing
  schema-validated recommendations into the Approval Queue — advisory alerts,
  and `trade` proposals once trading is switched on.
- **Investments (Phase 3a):** broker positions with unrealized P&L and
  allocation, recent orders, and the platform's own execution attempts —
  refusals included, since a guardrail that holds looks like nothing happening.
- **Reports (Phase 2):** cash flow Sankey, MoM/YoY trends, a saved custom
  report builder, the business tax export, and the recaps reader.
- **Goals (Phase 2):** three-step wizard with semantic linkage and a historical
  preview, nightly contribution matching, pace math, and true-cost panels.
- **Recaps (Phase 2):** weekly + monthly, deterministic math scored and
  narrated by Claude under a checked no-invented-numbers rule.
- **Workers:** sync / agent / executor under systemd, heartbeating every 30s.
- **Reboot persistence:** systemd user units + lingering; everything returns
  after a reboot.

## Ports (this machine runs other apps on 3000/3007/3100/3200)

| Service | URL |
|---|---|
| Web app | http://localhost:3141 |
| Supabase API | http://127.0.0.1:54321 |
| Postgres | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Studio | http://127.0.0.1:54323 |
| Mailpit (captured email) | http://127.0.0.1:54324 |

## Daily operation

**System tray (primary control):** a "Life Command" icon lives in the KDE
system tray — green sparkline when the stack is up, grey when down, with live
health in the tooltip. Left-click opens the dashboard (auto-starting the stack
if needed); right-click: Start / Stop (frees ~2 GB RAM) / Restart / Status /
Studio / Quit. Runs as the `finance-tray` user service
([scripts/tray.py](scripts/tray.py), pure python3-gobject).

**App menu entry:** "Life Command" is also in the KDE app launcher. Pin it to
the task bar from the *app menu* (right-click the menu entry → Pin), not from
a running window — Chrome app-mode windows on Wayland identify as "chrome",
so window pins break. For a perfectly pinnable window, open the dashboard in
Chrome and use menu → Cast, save and share → Install page as app — the PWA
manifest gives it a proper identity. Both installed by
`scripts/install-desktop.sh`; control logic in `scripts/stack-ctl.sh`.

Everything is a systemd user service and starts at boot. Manual controls:

```bash
npm run svc:status    # all three services
npm run svc:restart   # bounce web + workers
npm run svc:logs      # follow logs
npm run svc:stop      # stop web + workers (supabase keeps running)
```

After changing `supabase/config.toml`: `systemctl --user restart finance-supabase`
(its start also re-syncs env files). After changing web code: `npm run build`
then `npm run svc:restart`. Dev loop: `npm run dev` (Next dev server on 3000 —
pass `-p` if that clashes) or use the systemd build.

## First-time setup on a new machine

```bash
npm install
npx supabase start          # pulls Docker images, applies migrations
node scripts/sync-env.mjs   # writes .env files from the running stack
OWNER_EMAIL=you@example.com node scripts/create-owner.mjs
npm run build
bash scripts/install-services.sh
npm run svc:start

git config core.hooksPath scripts/hooks   # PII guard; see below
```

Then add your own keys to the root `.env` (Plaid, Anthropic, Google, ntfy) and
re-run `npm run env:sync` — it preserves keys you added and rewrites only the
ones derived from the running stack.

## Platform support

The application is portable: Node, Next and the Supabase CLI behave the same
everywhere, and nothing in `apps/` or `packages/` assumes a POSIX path. What
differs is only the layer that keeps it running at login.

| | Runs | Autostart at login | Notes |
|---|---|---|---|
| **Linux** | yes | yes — systemd user units | Developed here; the reboot path is tested |
| **macOS** | yes | yes — launchd agents | Generated by `npm run svc:install` |
| **Windows** | yes | manual — Task Scheduler | `npm run up` works; no service integration yet |

`npm run svc:*` dispatches to whatever the host actually has, so the same
commands work on Linux and macOS:

```bash
npm run svc:install    # systemd units, or ~/Library/LaunchAgents plists
npm run svc:start
npm run svc:status
npm run svc:logs
```

**Every platform** can run it in the foreground instead, which is fully
functional and simply does not survive a reboot:

```bash
npm run up
```

**Docker Desktop must be running before Supabase starts** on macOS and
Windows. Set it to launch at login in its own settings — the launchd agent
waits for the CLI, not for Docker itself.

**Windows** has no autostart integration yet. `npm run up` runs everything;
for login start, create two Task Scheduler tasks with *Start in* set to this
directory, running `node scripts\\launch-web.js` and
`node scripts\\launch-workers.js`. `npm run svc:start` prints these
instructions rather than failing.

**Not portable, Linux-only, and not required:** the desktop launcher, the
system-tray controller (`scripts/tray.py`, KDE/Wayland), and
`scripts/harden-docker-loopback.sh`. These are conveniences on the author's
machine; nothing depends on them.

## Plaid setup, end to end

The part that takes longest is not code. Sandbox works in minutes; production
took roughly two weeks of back-and-forth, almost all of it waiting on reviews.

### 1. Sandbox — enough to build against

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com).
2. **Team Settings → Keys** — copy `client_id` and the **Sandbox** secret.
3. Put them in the root `.env`, then `npm run env:sync`:

   ```
   PLAID_CLIENT_ID=...
   PLAID_SECRET=...
   PLAID_ENV=sandbox
   ```

4. Restart (`npm run svc:restart`) and link anything from the app. Sandbox
   credentials are `user_good` / `pass_good`.

### 2. Production access

**Dashboard → Request production access.** You are asked for a company, a
product description, and expected volume. A personal, single-user, self-hosted
tool is an accepted answer — say exactly that. Approval took a few days.

Plaid then requires a **Compliance Center** app profile before any production
key works:

- **App name, description, logo** (a 1024×1024 PNG; a plain wordmark is fine).
- **A public-facing URL** describing the app. Plaid checks this. A single page
  on a domain you control is enough — it needs to describe what the app does,
  what data it accesses and why, and link a privacy policy.
- **Security questionnaire** — encryption at rest and in transit, access
  control, retention. `docs/` in this repository carries the policy documents
  that answer it, as templates with `<OWNER NAME>` placeholders. Fill them in,
  export to PDF, upload. **Do not commit the filled-in PDFs** — `docs/*.pdf`
  is gitignored for that reason.

Once approved, swap the secret and env:

```
PLAID_SECRET=<production secret>
PLAID_ENV=production
```

> **`npm run env:sync` is not optional here.** Next.js does not read the
> repo-root `.env`, so the web app kept using sandbox while the workers were
> already on production — link tokens minted against one environment and
> exchanged against the other, with a confusing error. Sync, then restart both
> services.

### 3. OAuth institutions — the slow part

Chase, Wells Fargo, Bank of America, Capital One and similar require Plaid to
register **your specific application** with each bank before it can link.
Submitted once from the dashboard, then reviewed **per institution**, and the
reviews run in parallel. Budget **2–4 weeks** for the large banks. Nothing in
your code changes; the institution simply cannot be linked until its review
clears. Smaller banks and credit unions generally work immediately.

### 4. Item limits — read this before linking

The trial plan allows **10 live Items** (one Item = one set of credentials at
one institution). **Unlinking does not return the slot.** Link deliberately.

Two consequences worth knowing:

- A card that two people can both see is **one** card. Linking it under each
  person's login burns two slots and double-counts every balance and
  transaction — Plaid issues a different `account_id` per Item, so the unique
  constraint never fires. The exchange endpoint refuses duplicates and names
  which household member already holds them.
- Linking someone else's bank must be done as **them**: the link token is
  scoped per household member, because Plaid keys its returning-user
  experience off `client_user_id`. Set *Linking for* before opening Link, or
  it opens straight into the owner's own Plaid session.

### 5. What is actually stored

Access tokens are encrypted with `APP_ENCRYPTION_KEY` before they touch the
database, and are only ever decrypted inside the worker. The browser never
receives a Plaid token or secret. Account identifiers are masked to the last
four digits everywhere, including in anything sent to a model.

## Keeping personal data out

This repository is public and the app runs on real financial data, so the two
must not meet.

- **`scripts/hooks/pre-commit`** blocks staged secrets (`sk-ant-`, JWTs,
  Google client secrets), email addresses, 9-or-more-digit numbers that look
  like account or reference numbers, and any term in `.pii-denylist`.
- **Enable it on a fresh clone:** `git config core.hooksPath scripts/hooks`
- **`.pii-denylist`** is gitignored — the list of things you must not publish
  is itself something you must not publish. One term per line:

  ```
  echo "Some Landlord LLC" >> .pii-denylist
  ```

- Examples in comments are **invented**. Concrete examples explain a bug far
  better than abstract ones, so they stay concrete and stop being real.
- Genuine false positive: `git commit --no-verify`.

## Key scripts

| Command | What it does |
|---|---|
| `npm run db:reset` | Re-applies all migrations to a clean DB (wipes data) |
| `npm run db:types` | Generates TS types from the live schema into `packages/shared` |
| `npm run env:sync` | Rewrites env files from `supabase status` |
| `npm run owner:create` | Creates/repairs the owner user (idempotent; `OWNER_PASSWORD` to rotate) |
| `npm run up` | Foreground boot, all platforms, no service manager |

## Secrets policy (spec §7)

All keys live in gitignored `.env` files, written by `scripts/sync-env.mjs`
and read server-side only. The browser sees only the anon key; RLS plus the
`app_owner` allow-list gate every row. Add future keys (Plaid, Anthropic,
Alpaca, Kalshi) to root `.env` — `sync-env` preserves unmanaged lines.

## Local-stack gotchas (learned the hard way)

- **Table grants:** this Supabase version does **not** auto-grant DML on new
  tables to API roles — every new table needs grants (see
  `supabase/migrations/20260804000300_grants.sql`; default privileges now
  cover future tables).
- **`[auth.email] enable_signup = false` disables email sign-IN entirely.**
  Registration lockdown belongs to the global `[auth] enable_signup` only.
- **Docker's daemon `"ip"` option only affects the default bridge network.**
  User-defined networks (compose, supabase CLI) need
  `default-network-opts.bridge.com.docker.network.bridge.host_binding_ipv4`,
  and the setting only applies to networks created after it — hence the full
  stop/start in `scripts/harden-docker-loopback.sh`.
- **The repo path contains a space**, which pm2's daemon cannot survive
  (unquoted shell paths). That's why process management is systemd user units
  running `scripts/launch-*.js` instead of pm2, and why those launchers exist
  rather than `.bin` shims.

## Phase 1 notes

- **Linking:** Overview → "Link institution". Sandbox accepts any bank with
  `user_good` / `pass_good`. The post-link dialog flags business accounts
  (auto-stamps every transaction + requests receipts).
- **Sync:** every 6h automatically; "Sync now" on Overview queues a worker
  job. Recurring detection + net-worth snapshot run nightly at 02:00.
- **Categorization:** Plaid baseline → your rules (Transactions → Rules, with
  retroactive apply + preview) → merchant map (any inline category correction
  teaches it permanently) → review inbox for the leftovers.
- **Self Improvement ingest:** drop JSON/CSV/MD into `si-inbox/`, or
  `POST /api/si/entries` with `Authorization: Bearer $SI_API_TOKEN`.
- **OAuth institutions need registration.** Production approval alone does not
  unlock the big banks. Plaid's Compliance Center → App profile (name, logo,
  website URL, reason for data access, contact email) is submitted once, then
  each OAuth institution reviews it independently — some take 2–4 weeks. Banks
  that don't use OAuth work as soon as production keys are in `.env`. Check
  which is which under *View institutions* in the dashboard.
- **Before linking real institutions** (Trial plan, 10 Items, slots don't
  return on unlink): purge sandbox data —
  `delete from institutions; delete from net_worth_snapshots; delete from recurring_items;`
  via Studio or psql (cascades take accounts/transactions).

## Phase 2 notes

- **Gmail receipts (multi-account).** Account page → *Connect Gmail*, repeat
  per mailbox. Each connection gets **Choose receipt labels**: chips listing
  that inbox's real Gmail labels (via `/api/gmail/labels`), plus a
  *Purchases (auto)* chip for Gmail's own purchase category. Selections build
  the poll query; a hand-written *advanced* query overrides them. Blank = the
  default receipt-subject search. A 7-day recency guard is auto-appended.
  Polling runs every 45s per mailbox; a duplicate guard (same vendor + total
  within ±6h) stops a CC'd receipt creating two anticipations.
- **Receipt parsing.** Regex first (labeled totals, card last-four); when a
  verified sender yields no total, an LLM pass classifies purchase-vs-noise
  and extracts vendor/total/last4. Noise (shipping updates, mail previews) is
  marked `ignored` and hidden. A background backfill re-parses older
  unparsed receipts a few per cycle.
- **Anticipation → reconciliation.** Every legitimacy-verified receipt creates
  an anticipated charge (card attributed via last-four ↔ `accounts.mask`).
  When the bank transaction posts, a composite score (amount, descriptor /
  name match, date, last-four) auto-reconciles at high confidence, raises a
  one-tap *"Is X the same as Y?"* prompt at medium (the answer persists as a
  permanent vendor alias), and leaves the rest in the ambiguous queue.
  Unposted after 14 days → review as possible refund / cancellation / fraud.
- **Watchlist.** Flag any vendor `fraud` or `cancelled`; hits fire at all four
  ingress points (receipt ingest, anticipation, Plaid sync, recurring
  detection) with an instant alert and an auto-filed dispute queue item.
- **Notifications.** Set `NTFY_TOPIC` in `.env` and subscribe to that topic in
  the ntfy app for push alerts at email speed.
- **The agent.** Daily 06:00, or *Run analysis now* on `/agent`. Advisory
  until trading is switched on (see *Turning on paper trading*). Model via
  `AGENT_MODEL` (default `claude-sonnet-5`); receipt parsing via
  `RECEIPT_MODEL`.
- **Budgets.** `/budget` — auto-fill from trailing 6-month averages,
  category and flex modes, rollovers, pace bars.
- **Reports.** `/reports`, five tabs sharing one period picker. *Cash flow* is
  a hand-built Sankey (income sources → cash in → spending groups →
  categories); the hub is deliberate, since nothing in the data says which
  paycheck paid which bill. *Trends* charts 12 months and compares the period
  against the prior period or the same period last year. *Recaps* reads the
  weekly/monthly recaps. *Builder* filters on anything and saves the
  configuration to `saved_reports`. *Business & tax* exports business expenses
  by entity/category/date with a receipt reference on every line and a
  missing-receipt count.
- **Goals.** `/goals` — the wizard's three steps are define → link → preview.
  The linking step is the point: funding accounts, categories/tags that count
  as contributions, and cost-driver liabilities or recurring items. Step three
  replays six months of real transactions through that linkage and shows what
  last month's recap *would* have said, so a wrong link is visible before you
  save. Contributions auto-match nightly (both legs of a transfer collapse to
  one), manual attachments survive re-matching, and each goal's detail view
  expands every attributed cost down to its arithmetic.
- **Enrichment.** Daily 05:30, before the agent runs. Transactions the
  deterministic pipeline left uncategorized go to Claude in batches; ≥0.8
  confidence applies the category, below that lands in the review inbox with
  the model's own reason. Only single-purpose merchants at ≥0.92 teach
  `merchant_map` — Amazon and Target never do, which is the whole point. The
  same pass scores personal-account transactions for business likelihood into
  a suggestion inbox on Transactions → Business; dismissing a merchant
  suppresses it permanently. `ENRICH_MODEL` overrides the model; *Enrich now*
  on `/agent` runs it on demand.
- **Recaps.** Weekly Sunday 22:00, monthly on the 1st. Stage 1 is pure code:
  cash flow vs the prior period, budget adherence, credit utilization, goal
  cost attribution (interest from carried balance × APR ÷ 365 × days, stored
  with its formula and the exact contributing transaction ids), and net
  efficiency per goal. Stage 2 sends those facts to Claude for five 0–100
  domain scores, the narrative, and adjustments. **Every figure in the prose is
  then checked against Stage 1's numbers** — an unsourced figure fails the
  whole run, which is logged and surfaced rather than shown. Accepting an
  adjustment files it into the Approval Queue; monthly recaps add subscription
  verdicts as keep/replace/cut/watch decision cards with an addressable-savings
  headline.

## Roadmap

- [x] **Phase 0 — Foundation:** local stack, schema, auth, worker skeleton, reboot persistence
- [x] **Phase 1 — Read everything:** Plaid Link + sync (encrypted tokens), categorization pipeline v1, recurring detection, business layer v1, net-worth snapshots, SI section v1 — *sandbox-verified; real-institution acceptance pending Trial approval*
- [ ] **Phase 2 — The brain (read-only):** *feature-complete except Aldyn ([getaldyn.com](https://getaldyn.com)) Path A*
  - [x] Budgets (category + flex, rollovers, 6-month auto-fill)
  - [x] Agent worker v1 + Approval Queue (advisory) + Agent control page
  - [x] Gmail receipt ingestion (multi-mailbox, label mapping, LLM parse), anticipation engine, scored reconciliation, vendor watchlist
  - [x] Reports: cash flow Sankey, summaries, MoM/YoY, saved reports, business tax export
  - [x] Goals wizard + `goal_links` semantic mapping + contribution matching + pace math
  - [x] LLM categorization enrichment + business suggestion engine
  - [x] Recap engine (Stage 1 deterministic math → Stage 2 LLM scoring/narrative) + subscription review
  - [ ] Aldyn ([getaldyn.com](https://getaldyn.com)) Receipts API (Path A) — replaces Gmail OAuth
        once live (blocked on the Aldyn-side build)
- [ ] **Phase 3 — Human-approved execution:** Alpaca paper → Kalshi demo → transfers, executor guardrails
  - [x] Executor + guardrails in code, append-only `executions` ledger
  - [x] Agent emits `trade` proposals, pre-checked against the same guardrails before they reach the queue
  - [ ] 30 days of paper trading with zero guardrail violations (needs broker keys)
  - [x] Investments page — positions with P&L and allocation, broker orders, and this platform's own attempts including refusals
  - [ ] Kalshi demo (`prediction_position`), then transfers
- [ ] **Phase 4 — Bounded autonomy:** allow-listed auto-execution, circuit breakers, notifications
- [ ] **Phase 5 — Hosted migration** (optional): Vercel + hosted Supabase + Render, same migrations
- [ ] **Phase 5 — Desktop app packaging:** Tauri shell, approval-badge count on the tray icon, native notifications wired to `notification_rules` (tray v0 + launcher + installable PWA manifest exist now)
- [ ] **Settings: per-function model selector** — choose the Claude model per LLM function (agent analysis, categorization enrichment, recap scoring, subscription review) from a settings UI; currently env-based (`AGENT_MODEL`, default `claude-sonnet-5`)

## Backups

**The database is the only thing here that cannot be rebuilt.** Transactions
re-sync from Plaid and everything derived from them recomputes; what does not
come back is the teaching — manual corrections and the merchant map built from
them, review decisions, goals, budgets, household assignments, receipts, and
the Plaid access tokens, which live encrypted in the database and cannot be
re-issued by Plaid. Losing them means re-linking every institution, and on a
Trial plan those Item slots are not returned.

This install learned that on 2026-08-29. The repo was being synced off-machine
the whole time; Postgres was not, because it lived in a Docker volume on a
scratch disk outside every synced path.

```
npm run db:backup            # pg_dump -Fc + storage bucket, dated
npm run db:restore -- --list # what is available
npm run db:restore           # newest, after confirmation
npm run db:restore -- <file> # a specific dump
```

Backups are written **outside the repo**, to a sibling directory
(`../Supabase Backup - Finance Dashboard/`, override with `BACKUP_DIR`). That is
deliberate: a dump holds real balances and merchant names and this repo is
public, so keeping it out of the working tree means it cannot be committed even
by accident. Whatever already syncs your projects directory carries it
off-machine without further configuration.

Each run writes three files plus the bucket when it has contents — the dump,
a `pg_restore -l` table of contents, and a log recording row counts at the time
of the dump. The row counts matter: a dump that restores cleanly and contains
nothing is the failure this exists to prevent, and a file size in megabytes does
not tell the two apart. Fourteen sets are kept (`BACKUP_KEEP`).

`npm run svc:install` installs `finance-backup.timer`, which runs nightly at
03:30 with `Persistent=true` so a machine that was asleep still gets its backup
when it wakes.

**Restore is written and tested alongside the backup, not after the first
disaster.** A dump nobody has restored is a file, not a backup. It was verified
the only way that counts — `drop schema public cascade`, then restore — which is
what caught the dump omitting `CREATE SCHEMA`, and `--no-acl` silently stripping
every GRANT.

A failed backup fires `finance-backup-notify.service`: a desktop toast and, if
`NTFY_TOPIC` is set, a push. A nightly job that stops running looks exactly like
one that runs, and the failure that costs you something is the one nobody was
sitting at the machine to see.

**What this still does not protect against**, so it is not mistaken for more
than it is:

- Up to 24 hours of loss between snapshots. Transactions re-sync from Plaid, so
  the real exposure is a day of manual corrections.
- The backups share a disk with the repo (`/`), not with the database
  (`/mnt/scratch`) — which is what makes them survive the failure that has
  already happened once. A root-disk failure is a different story, and the
  off-machine copy in Drive is what covers it.
- Nothing yet proves an *old* dump still restores. The nightly run checks that a
  dump was written and records row counts; it does not restore it. A periodic
  test-restore into a throwaway database is the honest next step.

## Aldyn

**Aldyn ([getaldyn.com](https://getaldyn.com))** is a separate receipt-capture
product by the same author. This platform can take receipts from it directly
(Path A) instead of scraping Gmail (Path B), which removes the OAuth
dependency and gets structured line items rather than parsed HTML. Path A is
optional and not required to run anything here — Gmail ingestion works
standalone, and everything in this repository is written against Path B.

## Environment keys

Everything lives in the gitignored root `.env`; `npm run env:sync` propagates
what the web app and workers need.

| Key | Needed for | Status |
|---|---|---|
| `SUPABASE_*`, `DATABASE_URL` | local stack | managed by `env:sync` |
| `APP_ENCRYPTION_KEY` | Plaid/Gmail token encryption | generated at setup |
| `SI_API_TOKEN` | `POST /api/si/entries` | generated at setup |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | banking aggregation | set (production) |
| `ANTHROPIC_API_KEY` | agent + receipt parsing | set |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail receipts | set |
| `AGENT_MODEL` / `RECEIPT_MODEL` / `ENRICH_MODEL` / `RECAP_MODEL` | per-function model overrides (default `claude-sonnet-5`) | optional |
| `NTFY_TOPIC` | push notifications (recaps, receipts, watchlist) | optional |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | Phase 3a paper trading | needed to execute |
| `ALPACA_PAPER_BASE` | points paper at a stub broker instead of Alpaca, for exercising order placement without an account | testing only |
| `KALSHI_*` | Phase 3b | not yet needed |

`NTFY_TOPIC` is a credential, not a name: on ntfy.sh anyone who knows the topic
string reads every notification it carries. Generate a random one and treat it
like a password.

```
NTFY_TOPIC=lifecmd-$(openssl rand -hex 16)
```

### Turning on paper trading

A fresh install refuses every order, and that is the intended starting state.
Trading is opt-in at five independent points, each checked against the world
rather than asserted — turning on four of them does nothing. **The Execution
card on `/agent` lists all five and says which one is off**, since an empty
approval queue looks identical either way.

1. `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` in root `.env`, then
   `npm run env:sync`. This one is the only step that is not in the UI —
   secrets stay in the environment.
2. Allow-list `trade` (`agent_config.allowed_action_types`).
3. Autonomy level — `1` lets the agent *propose* trades, `2` lets an approved
   one *execute*. `0` is read-only and disarms both.
4. The caps, all defaulting to `0`: per-transaction, daily, per-position, and
   open positions. A cap of zero refuses everything.
5. One agent-controlled account. Alpaca is not a bank Plaid aggregates, so
   *Create it from the broker* makes the row by asking Alpaca who it is. Zero
   flagged accounts means no trading; two or more also means no trading,
   because the agent must never pick between accounts — code stamps the account
   into every order and the model never chooses. Naming one unnames the rest.

`agent_config.execution_mode` defaults to `paper` and must be changed by hand;
the spec gates `live` on 30 days of clean paper trading.

Both sides check the same rules. The agent discards a proposal that would breach
a cap before the owner ever sees it, so the queue only offers Approve on
something that could actually go through; the executor then re-derives every
input from the database and the broker and decides again at execution time,
because approval says "I want this" and says nothing about whether it is still
inside the limits. Every attempt is written to `executions`, refusals included —
"30 days with zero guardrail violations" is not checkable against a table that
only remembers the orders that went through.

Google OAuth setup: Cloud Console → enable Gmail API → OAuth consent screen
(External, published unverified so refresh tokens don't expire weekly) →
credentials → Web application → redirect URI
`http://localhost:3141/api/gmail/callback`.

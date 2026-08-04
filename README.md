# Personal AI Finance Platform

Self-hosted AI accountant: aggregates accounts, tracks goals, surfaces
recommendations, and graduates from read-only analysis to human-approved
execution to bounded autonomy. Full design in
[ai-finance-platform-spec.md](./ai-finance-platform-spec.md).

**Status: Phase 2 feature-complete (Aldyn Path A pending); Phase 3 next.**
Local-only, zero hosting cost. Plaid production access is approved; OAuth
institutions (Chase, Wells Fargo, BoA and friends) need a separate per-bank
registration review before they can be linked. Gmail receipt ingestion is live
on real mail.

> This is one person's self-hosted build, shared as-is under MIT. It assumes a
> single owner and a local Supabase stack — there is no multi-tenancy anywhere
> and none is planned. Everything instance-specific lives in `.env`; see
> [Environment keys](#environment-keys). `docs/` carries the security and
> data-retention policies Plaid's questionnaire asks for, as templates with
> `<OWNER NAME>` placeholders — fill them in and generate your own PDFs.

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
- **The agent (Phase 2):** daily analysis run on `claude-sonnet-5` producing
  schema-validated advisory recommendations into the Approval Queue.
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
```

## Key scripts

| Command | What it does |
|---|---|
| `npm run db:reset` | Re-applies all migrations to a clean DB (wipes data) |
| `npm run db:types` | Generates TS types from the live schema into `packages/shared` |
| `npm run env:sync` | Rewrites env files from `supabase status` |
| `npm run owner:create` | Creates/repairs the owner user (idempotent; `OWNER_PASSWORD` to rotate) |
| `npm run up` | Manual full-stack boot without systemd |

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
  only (autonomy locked to 0–1 until Phase 3). Model via `AGENT_MODEL`
  (default `claude-sonnet-5`); receipt parsing via `RECEIPT_MODEL`.
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
- [ ] **Phase 2 — The brain (read-only):** *feature-complete except Aldyn Path A*
  - [x] Budgets (category + flex, rollovers, 6-month auto-fill)
  - [x] Agent worker v1 + Approval Queue (advisory) + Agent control page
  - [x] Gmail receipt ingestion (multi-mailbox, label mapping, LLM parse), anticipation engine, scored reconciliation, vendor watchlist
  - [x] Reports: cash flow Sankey, summaries, MoM/YoY, saved reports, business tax export
  - [x] Goals wizard + `goal_links` semantic mapping + contribution matching + pace math
  - [x] LLM categorization enrichment + business suggestion engine
  - [x] Recap engine (Stage 1 deterministic math → Stage 2 LLM scoring/narrative) + subscription review
  - [ ] Aldyn Receipts API (Path A) — replaces Gmail OAuth once live (blocked on the Aldyn-side build)
- [ ] **Phase 3 — Human-approved execution:** Alpaca paper → Kalshi demo → transfers, executor guardrails
- [ ] **Phase 4 — Bounded autonomy:** allow-listed auto-execution, circuit breakers, notifications
- [ ] **Phase 5 — Hosted migration** (optional): Vercel + hosted Supabase + Render, same migrations
- [ ] **Phase 5 — Desktop app packaging:** Tauri shell, approval-badge count on the tray icon, native notifications wired to `notification_rules` (tray v0 + launcher + installable PWA manifest exist now)
- [ ] **Settings: per-function model selector** — choose the Claude model per LLM function (agent analysis, categorization enrichment, recap scoring, subscription review) from a settings UI; currently env-based (`AGENT_MODEL`, default `claude-sonnet-5`)

## Environment keys

Everything lives in the gitignored root `.env`; `npm run env:sync` propagates
what the web app and workers need.

| Key | Needed for | Status |
|---|---|---|
| `SUPABASE_*`, `DATABASE_URL` | local stack | managed by `env:sync` |
| `APP_ENCRYPTION_KEY` | Plaid/Gmail token encryption | generated at setup |
| `SI_API_TOKEN` | `POST /api/si/entries` | generated at setup |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | Phase 1 banking | set (sandbox) |
| `ANTHROPIC_API_KEY` | agent + receipt parsing | set |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail receipts | set |
| `AGENT_MODEL` / `RECEIPT_MODEL` / `ENRICH_MODEL` / `RECAP_MODEL` | per-function model overrides (default `claude-sonnet-5`) | optional |
| `NTFY_TOPIC` | push notifications | optional |
| `ALPACA_*` / `KALSHI_*` | Phase 3 execution | not yet needed |

Google OAuth setup: Cloud Console → enable Gmail API → OAuth consent screen
(External, published unverified so refresh tokens don't expire weekly) →
credentials → Web application → redirect URI
`http://localhost:3141/api/gmail/callback`.

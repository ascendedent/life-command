# Personal AI Finance Platform: Research & Phased Build Plan

**Owner:** single user, self-hosted
**Purpose:** A self-hosted AI accountant that aggregates all financial accounts, tracks goals, surfaces recommendations through a dashboard, and graduates from read-only analysis to human-approved execution to bounded autonomy, including active growth via stock and prediction markets.
**This document is the build spec for Claude Code.** It contains the research findings, architecture, data model, UI spec, and a phase-by-phase implementation plan with acceptance criteria.

---

## 1. Research Summary (as of August 2026)

### 1.1 Account aggregation (read layer)

- **Plaid** is the primary choice. Covers 12,000+ US institutions. Products needed: Transactions (24 months history, categorized), Balance, Investments, Liabilities. Personal projects apply through Plaid's Limited Production / development access tier. Sandbox is free and fully featured for building everything before approval.
- **Fallbacks:** SimpleFIN Bridge (cheap, hobbyist-friendly, read-only), MX, Yodlee. Only needed if Plaid coverage misses a specific institution.
- **Key constraint:** Plaid is a data layer only. It cannot move money by itself.

### 1.2 Money movement (action layer)

This is the hardest layer for a personal app. Options in order of preference:

1. **Intra-institution transfers via brokerage APIs.** Alpaca supports programmatic ACH funding of its own account. Simplest legally and technically: the agent moves money into and out of accounts the platform natively controls.
2. **Astra** (astra.finance): consumer-facing transfer automation built on Plaid Auth. Supports recurring and conditional ACH routines between a user's own linked accounts. Best fit for checking-to-savings optimization routines.
3. **Plaid Transfer:** full ACH origination, but aimed at businesses with sponsor bank relationships. Hard approval for a personal app. Treat as out of scope unless Astra fails.

**Regulatory note:** This is a single-user personal tool moving the owner's own money between the owner's own accounts. That avoids money transmitter licensing, fiduciary duty, and RIA registration concerns, which all attach when handling other people's money. Real constraints are bank terms of service and API access approvals. All autonomous-execution guardrails below are still mandatory for safety, not legal, reasons.

### 1.3 Trading (growth layer)

- **Alpaca Trading API** (individual account, not Broker API): commission-free stocks, ETFs, options, crypto. Full REST + WebSocket. Paper trading environment mirrors live account behavior, so every strategy runs in paper mode first with identical code. Basic market data plan is free; Algo Trader Plus if higher data needs emerge.
- **Kalshi** (prediction markets): the only CFTC-regulated, dollar-settled prediction market with full API trading support. REST, WebSocket, and FIX. Has a demo environment for safe testing. Auth uses RSA-PSS request signing with API keys. Rate limits roughly 20 req/sec on standard tier.
- **Polymarket:** crypto-settled, region-restricted, legal gray areas. Out of scope. Kalshi covers the regulated equivalent.

### 1.4 AI layer

- **Anthropic API (Claude)** as the reasoning engine. The model receives normalized financial state (accounts, balances, cash flow, goals, holdings) and produces structured recommendation objects, never free-form actions.
- Context/state persistence is our job: the model is stateless between calls, so all financial state, goal state, and recommendation history live in Postgres and are assembled into each prompt.
- Structured outputs: prompt for strict JSON, parse and validate server-side against a schema before anything touches the recommendation queue.

### 1.5 Industry guardrail consensus

Every serious agentic-finance implementation follows the same rules, and so will we:

- Never give the agent direct access to the primary account. It operates on a dedicated, capped sub-account.
- Scoped spend limits per transaction and per day, enforced in code at the execution layer, not by prompt instructions.
- Circuit breakers: automatic halt on anomalous velocity, drawdown thresholds, or repeated failures.
- Human-in-the-loop approval for everything above thresholds, forever, even in the autonomy phase.
- Immutable audit log of every recommendation, approval, execution, and result.

### 1.6 Monarch Money teardown (feature benchmark to match, then beat)

Monarch ($99/yr Core, $199/yr Plus) is the current best-in-class consumer PFM and our functional baseline. Full teardown:

**Categorization system:**
- Roughly 60 default categories organized into groups (Income / Expenses / Transfers), each with name + emoji. Defaults can be renamed or disabled but not deleted; Uncategorized always exists as the fallback. Custom categories and custom groups supported.
- Per-category flags: rollover fund (unspent budget carries to next month) and exclude-from-budget. Groups can be budgeted at group level or per category.
- Investment-aware categories appear automatically on first investment sync: buys/sells categorize as transfers, dividends/capital gains as income, so investing doesn't pollute spending analytics.
- ML auto-categorization at roughly 90% first-pass accuracy, improving with merchant recognition over time.
- **Rules engine** (their power feature): criteria on merchant/amount/account, actions include recategorize, rename merchant, add tags, hide from budget/cash flow, mark for review (e.g. only txns over $X), and link to goals or debt-paydown tracking. Rules can apply retroactively to old transactions.
- **Review workflow:** transactions can be flagged "needs review" by custom rules, giving an inbox-zero flow so users only touch exceptions.
- **Tags** as a cross-cutting dimension (e.g. tag a vacation across many categories).
- Known weak spot even for power users: mixed-basket merchants (Amazon, Costco, Target) still need manual splitting. Their answer is receipt scanning / email receipt forwarding with item-level categorization.

**Budgeting:**
- Two styles: classic **category budgeting** (limit per category) and **flex budgeting** (three buckets: fixed, flexible, non-monthly; you track one "flexible remaining" number). Both support rollover balances, spending alerts, and forecasts.
- First budget auto-fills from the trailing 6-month average per category, with a recalculate button. Budgets adjustable per individual month.

**Recurring & subscriptions:** dedicated recurring transactions page, detection of subscription and recurring-charge changes surfaced in the weekly recap.

**AI layer:** three features: an AI Assistant (chat over your data), AI Insights, and a Weekly Recap covering total spend and drivers, cash flow trends, subscription changes, and week-over-week net worth. All advisory only.

**Reports & planning:** Cash flow Sankey diagram, spending/income summaries, custom saved reports by category/tag/timeframe, and scenario forecasting (model buying a home, retiring early, career change; side-by-side scenario comparison in the Plus tier). Receipt scanning, transaction activity log, portfolio treemap, equity comp tracking, Zillow home value, Coinbase.

**Where Monarch falls short (our openings):**
1. **Read-only by design.** Monarch explicitly cannot move money. Our execution layer (Phases 3-4) is the fundamental differentiator.
2. **Sync reliability** is its most common complaint (aggregator disconnects, stale balances). Mitigate with a visible per-institution sync-health panel, one-tap relink, and manual CSV import as a always-available fallback.
3. **Shallow investment analysis** (no asset allocation depth, fee analysis, or Monte Carlo). We own the brokerage connection directly via Alpaca, so position-level analytics are first-party data, not aggregator scraps.
4. **AI is a commentator, not an operator.** Their assistant answers questions; ours produces executable, guardrailed recommendations.
5. **Categorization ceiling:** rules + ML still leave the Amazon problem. Our pipeline (below) adds an LLM enrichment pass and a learning merchant map so a correction never has to be made twice.

**Categorization pipeline spec (implement exactly this, in order):**
1. **Plaid PFC v2 taxonomy** as the automatic baseline category on every synced transaction.
2. **User rules engine** (priority-ordered, first match wins, retroactive apply supported) overrides the baseline. Criteria: merchant pattern, amount range, account, category. Actions: set category, rename merchant, add tags, hide, mark needs_review, link to goal.
3. **Merchant map:** every manual recategorization or rename upserts a `merchant_map` row, so the same merchant auto-resolves forever after one correction.
4. **LLM enrichment pass** (batched, in the daily agent run): transactions still Uncategorized or from known mixed-basket merchants go to Claude with description + amount + history context for a category suggestion with confidence; above threshold auto-applies (flagged as llm-sourced), below threshold lands in the review inbox.
5. **Review inbox** rules decide what needs human eyes; everything else flows silently.

**Business expense layer (on top of the pipeline):**
1. **Account-level default:** any account flagged `is_business` (with its `business_entity`, e.g. Acme Studios or Northwind Goods) stamps every transaction it syncs as business automatically. Zero-touch for dedicated business cards/accounts.
2. **Auto-suggestion on personal accounts:** the daily LLM pass also scores personal-account transactions for business likelihood (merchant type, amount patterns, similarity to confirmed business spend, e.g. SaaS tools, ad platforms, contractor payments, shipping). High-confidence matches create `business_suggestions` rows surfaced as a suggestion inbox: accept (tags it business and requests a receipt), dismiss (trains the model context; dismissed merchants aren't re-suggested).
3. **Receipt requests:** every business-tagged transaction gets `receipt_status = requested`. Uploads via UI (drag/drop or mobile photo) or the watched drop folder; files land in local Supabase Storage linked to the transaction, with optional LLM parse into `parsed`/`item_lines`. A visible "missing receipts" counter drives compliance. Waive option for transactions that genuinely have none.
4. **Tax-ready output:** business expenses filterable by entity, category, and date range in Reports, exportable with receipt references for the accountant.

### 1.7 Email receipt ingestion (Aldyn integration)

The owner owns Aldyn (getaldyn.com), an email organization app that already identifies and categorizes receipt emails. Two integration paths, built in this order:

**Path B first (interim): direct Gmail OAuth.** Add Google sign-in to the finance app with the `gmail.readonly` scope only. The ingest worker queries Gmail for the labels/categories Aldyn is already applying to receipt emails, pulls matching messages, and parses vendor, total, currency, and date into `email_receipts`. Local-first note: Google OAuth works fine with a localhost redirect URI (register the app in Google Cloud Console, add the owner's account as a test user, no verification review needed for personal use). This path ships value immediately with zero Aldyn-side work, and is explicitly marked for deprecation once Path A is live.

*As built (2026-08-04):* **multiple mailboxes** are supported (personal + business inboxes each hold their own credentials and receipt mapping), since receipts scatter across accounts. Per-mailbox receipt location is selected in the UI from that inbox's actual Gmail labels rather than hand-written queries, with Gmail's own purchases category available as a catch-all and a free-text query as an override. Regex parsing handles well-formed receipts; anything a verified sender sends that regex can't total falls through to an LLM pass that both classifies purchase-vs-noise (shipping notices, mail previews, and newsletters are filtered out rather than becoming phantom charges) and extracts vendor/total/card-last-four. Publishing the Google app as production-unverified avoids the 7-day refresh-token expiry that applies in testing mode.

**Path A (target): Aldyn Receipts API.** A small API built on the Aldyn side (Claude Code can build both halves; Aldyn is the source of truth for email, the finance app never touches raw mail in this path). Proposed contract, adjust to Aldyn's stack:

```
GET https://getaldyn.com/api/v1/receipts?since={iso8601}&cursor={cursor}
Authorization: Bearer {api_key}

200: {
  "receipts": [{
    "id": "...", "received_at": "...",
    "vendor": "...", "total": 123.45, "currency": "USD",
    "txn_date_guess": "...",            // charge date if parsed, else email date
    "aldyn_category": "...",
    "line_items": [{"desc": "...", "amount": 0.0}],
    "attachment_url": "...",            // signed, short-lived
    "email_ref": "..."                  // opaque pointer back into Aldyn
  }],
  "next_cursor": "..."
}
```

The finance worker polls this endpoint on the sync cron (polling, not webhooks, while local-first). `email_ref` lets the UI deep-link back into Aldyn.

**Matching engine (both paths feed it):** match `email_receipts` to `transactions` by amount + date + merchant:
- Exact amount within a ±3 day window and compatible merchant string: auto-match, receipt row created with `source = 'email_aldyn'` or `'gmail'`, transaction `receipt_status` flips to `uploaded`, `item_lines` filled from the parse.
- Near matches (amount within 2%, or 10-25% over for tip-adjusted restaurant charges) or multiple candidate transactions: land in an **ambiguous-match queue** with one-tap resolution; every resolution tunes future matching for that vendor.
- Unmatched receipts are retained 90 days awaiting late-posting transactions, then archived.

**Anticipatory transactions (the 30-second dashboard):** receipts arrive by email minutes after purchase; bank transactions post hours or days later. Instead of waiting, invert the flow. Anticipation is deliberately permissive: a receipt from a legitimate vendor domain is treated as a real purchase signal immediately, and confidence is resolved at reconciliation time rather than gatekeeping at creation time.

1. **Sender legitimacy check (the only hard gate):** the receipt email must pass DKIM/SPF and come from a plausible vendor domain (in Path A, Aldyn's own classification serves as this check). Receipts failing legitimacy never create anticipations and land in a quarantine view. This is the anti-phishing line; everything past it is fair game.
2. **Anticipate on every legitimate receipt:**
   - **Known vendor** (existing `vendor_signatures` row): full auto-anticipation with pre-assigned category, item lines, business flag, receipt attached.
   - **New/unknown vendor:** anticipate anyway, marked "unverified vendor." The row is user-editable ahead of the charge posting: the owner can approve it, reject it, or manually fill in vendor info (including pasting how the pending card transaction descriptor reads), which pre-seeds the signature before the bank even posts.
3. **Card attribution via last-four:** receipts usually carry the card's last four digits. Parse it and match against `accounts.mask` to attribute the anticipated transaction to the specific card already in the system. A last-four match is a strong confidence signal at reconciliation.
4. **Reconciliation as a scored linkage layer.** When a Plaid transaction posts, candidate anticipations are scored on a composite: amount match (exact strongest, small tolerance allowed), semantic vendor-name match (fuzzy + LLM comparison of receipt vendor vs bank descriptor), date proximity, and card last-four agreement.
   - **High confidence:** auto-reconcile silently.
   - **Medium confidence:** a one-tap clarification prompt: "Is *WM SUPERCENTER #3471* the same as *Walmart.com*?" The answer persists as a vendor alias in `vendor_signatures`, so every confirmation is permanent memory and the same question is never asked twice.
   - **Low confidence:** ambiguous queue.
5. **Signature learning runs on everything:** auto-reconciliations, clarification answers, and manual pre-fills all write to `vendor_signatures` (descriptor patterns + name aliases + per-vendor amount reliability). Vendors with systematic receipt/charge deltas (tips, gas pre-auths, Amazon split shipments) still anticipate, but reconcile through the scored layer rather than exact-match, and splits route to the ambiguous queue rather than being guessed.
6. **Expiry as signal:** an anticipated row unreconciled after 14 days flags for review: the charge never posting usually means a refund, a cancellation, or fraud worth noticing.
7. **Receipt-driven spend notifications:** user-defined `notification_rules` (e.g. "notify me on any charge over $X", "any charge from vendor Y", per-account variants) fire at anticipation creation time, meaning alerts arrive at email speed, not bank speed: "You just spent $188.40 at Walmart on the Amex ...4471." Delivered via the local notification channel (email or ntfy.sh push).
8. **Vendor red-flag watchlist (immediate, never waits for recaps):** vendors can be flagged `fraud` ("this was never legitimate") or `cancelled` ("we ended this, no further charges are valid"), with a reason and date. The watchlist is checked at every ingress point: email receipt ingestion, anticipation creation, Plaid transaction sync, and recurring detection. A hit fires a **red alert instantly** on the highest-priority notification channel plus a high-priority queue item carrying full context: the flag reason, when it was flagged, the offending charge, and for `cancelled` hits the cancellation date and a dispute/refund action prompt. Matching leverages `vendor_signatures` descriptor patterns and aliases, so a fraudster or zombie subscription can't dodge the list with a slightly different descriptor. Flag entry points are everywhere they'd naturally arise: any transaction row, any recurring item, expired-anticipation fraud reviews, and subscription-review "cut" verdicts (a confirmed cancellation auto-adds the vendor as `cancelled`). Recaps summarize watchlist activity, but detection and alerting never wait for one.
9. **Latency:** while local-first, the email ingest loop polls tightly (every 30-60s; Gmail API quotas comfortably allow this, and the Aldyn API poller can run at the same cadence). Plaid keeps its own slower cron; anticipated rows are what cover the gap.

**Analysis integration:** matched email receipts satisfy business receipt requests automatically (no manual upload), supply item-level lines for mixed-basket categorization, confirm subscription prices for the recurring detector and subscription reviews, and are counted in recap coverage stats (percent of business spend with receipts attached).

---

## 2. Stack Decision

**Deployment target for the initial build: the owner's local machine only. Zero hosting cost, nothing exposed to the internet.** the owner has Supabase, Vercel, Render, and AWS accounts available, but those are the *later* migration path, not the starting point. Design everything so the local build promotes to hosted with config changes only, no rewrites.

| Concern | Local (now, free) | Hosted (later) |
|---|---|---|
| Frontend + API routes | **Next.js 14+ (App Router) running locally** (`npm run dev`, or `next start` for a stable daily-driver build) | Vercel |
| Database, auth, RLS | **Supabase CLI local stack** (`supabase start`, runs Postgres + Auth + Realtime + Studio in Docker, fully free) | Hosted Supabase project (same migrations apply unchanged) |
| Secrets | **`.env.local` files, gitignored**, loaded server-side only | Supabase Vault |
| Background workers | **Local Node processes** using `node-cron` for schedules, run via `pm2` (or a single `npm run workers` process) so sync/agent/executor stay alive | Render background worker + cron |
| Realtime dashboard updates | Supabase Realtime (included in the local stack) | Same, hosted |
| Object storage | Supabase Storage (local stack) or plain local filesystem folder | Supabase Storage / S3 |

**Local-first implications Claude Code must respect:**

- Plaid webhooks cannot reach a local machine. While local, rely on cron-based polling for sync (every 2-6h) instead of webhooks. Structure the sync worker so webhook handling is an additive module enabled at hosted migration (or via an optional tunnel like `cloudflared` if the owner wants push updates sooner).
- The machine is a Windows/high-end PC used for Claude Code workloads. Everything must survive reboots: document a startup script (pm2 resurrect or Task Scheduler entry) so the stack comes back automatically.
- All connection strings, ports, and service URLs live in env config so hosted migration is a matter of swapping env values and pointing migrations at the hosted Supabase project.

**Repo layout:** monorepo, `apps/web` (Next.js) and `apps/worker` (Node worker processes), `packages/shared` (types, zod schemas, DB client).

---

## 3. Architecture

```
                    ┌─────────────────────────────┐
                    │  Next.js Dashboard (local)  │
                    │   read views + approval UI  │
                    └──────────┬──────────────────┘
                               │ Supabase client (RLS)
                    ┌──────────▼──────────────────┐
                    │  Supabase local stack       │
                    │  (Docker: Postgres + Auth   │
                    │   + Realtime + Studio)      │
                    │  accounts, txns, goals,     │
                    │  recommendations, si_entries│
                    │  audit_log, agent_config    │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │   Local Node Workers (pm2)   │
                    │  1. sync worker (Plaid pull) │
                    │  2. agent worker (Claude)    │
                    │  3. executor (Alpaca/Kalshi/ │
                    │     Astra, guardrail-gated)  │
                    └───┬──────────┬──────────┬────┘
                        │          │          │
                    Plaid API  Anthropic   Alpaca / Kalshi / Astra
```

**Data flow:** sync worker pulls Plaid data on cron (polling every 2-6h while local; webhooks added at hosted migration). Agent worker runs on cron (daily) and on-demand from the UI, reads full financial state, calls Claude, writes validated recommendation rows. Executor only ever consumes *approved* recommendation rows and enforces guardrails independently before touching any external API.

**Critical separation:** the agent worker can never call execution APIs. Only the executor can, and the executor never calls the LLM. The recommendation table is the only bridge between them.

---

## 4. Data Model (Supabase)

Core tables. Claude Code should generate migrations with RLS policies restricting all rows to the single authenticated user.

```sql
-- linked institutions and accounts
institutions (id, plaid_item_id, name, status, last_sync_at)
accounts (id, institution_id, plaid_account_id, name, type,        -- checking/savings/credit/investment/loan
          subtype, mask, current_balance, available_balance,
          is_agent_controlled boolean default false,               -- the capped sub-account flag
          is_business boolean default false,                       -- every txn on this account auto-tags business
          business_entity text,                                    -- e.g. 'Acme Studios' / 'Northwind Goods'
          updated_at)

-- transactions and holdings
transactions (id, account_id, plaid_txn_id, date, amount, merchant, merchant_clean,
              category_id references categories,            -- resolved category (pipeline output)
              category_source,                              -- 'plaid' / 'rule' / 'merchant_map' / 'llm' / 'user'
              plaid_category_primary, plaid_category_detail,-- raw PFC v2 baseline, kept for audit
              pending, hidden boolean default false,        -- hidden = excluded from budget/cash flow
              needs_review boolean default false, reviewed_at,
              notes text, item_lines jsonb,                 -- optional receipt item-level breakdown
              is_business boolean default false,
              business_source,                              -- 'account_default' / 'suggested_accepted' / 'user'
              business_entity text,
              receipt_status,                               -- null / 'requested' / 'uploaded' / 'waived'
              raw jsonb)
receipts (id, transaction_id, file_ref,           -- Supabase Storage (local stack) path
          uploaded_at, source,                    -- 'ui_upload' / 'drop_folder' / 'email_aldyn' / 'gmail'
          parsed jsonb)                           -- optional OCR/LLM extraction (vendor, total, line items)
email_receipts (id, source,                       -- 'aldyn_api' / 'gmail'
                external_id, email_ref,           -- dedupe key + deep link back into Aldyn
                sender_domain, sender_verified boolean,  -- DKIM/SPF + vendor-domain legitimacy gate
                card_last4,                       -- parsed from receipt when present
                received_at, vendor, total, currency, txn_date_guess,
                aldyn_category, line_items jsonb, attachment_ref,
                match_status,                     -- unmatched / auto_matched / ambiguous / resolved / ignored / archived
                matched_transaction_id, resolved_at, created_at)
vendor_signatures (id, vendor_name,               -- as seen on receipts
                   descriptor_patterns text[],    -- observed bank descriptors for this vendor
                   name_aliases text[],           -- confirmed "X is the same as Y" answers (permanent memory)
                   exact_match_count, mismatch_count,
                   reliability numeric,           -- informs reconciliation scoring weights
                   source,                        -- 'auto' / 'user_confirmed' / 'user_prefilled'
                   updated_at)
anticipated_transactions (id, email_receipt_id, created_at,
                          vendor, amount, currency, expected_descriptor_patterns text[],
                          card_last4, account_id, -- attributed card from receipt last-four vs accounts.mask
                          category_id, is_business, business_entity,
                          item_lines jsonb,
                          verification_state,     -- 'known_vendor' / 'unverified_vendor' / 'user_approved' / 'user_prefilled'
                          status,                 -- open / reconciled / expired_review / dismissed / quarantined
                          reconciliation_confidence numeric, reconciliation_factors jsonb,
                          reconciled_transaction_id, reconciled_at,
                          expires_at)             -- 14 days; expiry = refund/cancel/fraud signal
notification_rules (id, type,                     -- 'spend_threshold' / 'vendor_match' / 'account_activity'
                    min_amount, vendor_pattern, account_id,
                    channel,                      -- 'email' / 'ntfy'
                    is_active, created_at)
notifications_log (id, rule_id, anticipated_transaction_id, transaction_id,
                   sent_at, channel, content text)
vendor_watchlist (id, vendor_name, vendor_signature_id,     -- inherits descriptor patterns + aliases for matching
                  flag_type,                                -- 'fraud' / 'cancelled'
                  reason text, cancelled_on date,
                  source,                                   -- 'user' / 'subscription_review_cut' / 'expired_anticipation'
                  is_active boolean, flagged_at, resolved_at)
watchlist_hits (id, watchlist_id, detected_at,
                ingress,                                    -- 'email_receipt' / 'anticipation' / 'plaid_sync' / 'recurring_detect'
                anticipated_transaction_id, transaction_id, email_receipt_id,
                amount, alerted_at, recommendation_id,      -- the auto-filed dispute/refund queue item
                resolution, resolved_at)                    -- disputed / refunded / false_positive / accepted
business_suggestions (id, transaction_id, created_at, run_id,
                      confidence, rationale text,
                      status)                     -- pending / accepted / dismissed
holdings (id, account_id, symbol, quantity, cost_basis, market_value, as_of)
liabilities (id, account_id, type, apr, minimum_payment, next_due_date, balance)

-- categorization & budgeting (Monarch parity layer)
category_groups (id, name, type,                  -- income / expense / transfer
                 budget_mode,                     -- by_category / by_group
                 sort_order, is_active)
categories (id, group_id, name, emoji, is_system boolean,
            is_active, is_rollover boolean,       -- unspent budget carries forward
            exclude_from_budget boolean, sort_order)
tags (id, name, color)
transaction_tags (transaction_id, tag_id)
txn_rules (id, priority int,                      -- first match wins, retroactive apply supported
           criteria jsonb,                        -- merchant pattern, amount range, account, category
           actions jsonb,                         -- set_category, rename, add_tags, hide, needs_review, link_goal
           is_active, hit_count, last_hit_at)
merchant_map (id, raw_pattern, clean_name, default_category_id,
              confidence, source,                 -- 'user' / 'rule' / 'llm'
              updated_at)                         -- one correction resolves that merchant forever
recurring_items (id, merchant, category_id, cadence,        -- weekly/monthly/annual/custom
                 expected_amount, amount_tolerance_pct,
                 next_expected_date, account_id,
                 is_subscription boolean, status,           -- active / price_changed / missed / cancelled
                 purpose text,                              -- user-written: what this subscription accomplishes
                 value_notes text,                          -- user-written: why it's worth it / doubts / usage frequency
                 overlap_tags text[],                       -- capability tags for overlap detection (e.g. 'ai_coding', 'storage', 'video_editing')
                 last_reviewed_at,
                 last_seen_txn_id, created_at)
subscription_reviews (id, recap_id, recurring_item_id, created_at,
                      verdict,                              -- 'keep' / 'replace' / 'cut' / 'watch'
                      reasoning text,
                      suggested_alternative text,           -- existing tool, cheaper tier, or new tool
                      projected_monthly_savings numeric,    -- from actual observed prices (Stage 1)
                      user_decision,                        -- null / 'accepted' / 'rejected' / 'deferred'
                      decided_at)
budgets (id, month date, style)                   -- 'category' / 'flex'
budget_lines (id, budget_id, category_id,         -- null when flex bucket line
              flex_bucket,                        -- fixed / flexible / non_monthly (flex style only)
              amount, rollover_in, spent_cached)
net_worth_snapshots (id, date, total, by_account_type jsonb)
saved_reports (id, name, config jsonb, created_at)

-- goals + semantic linkage (powers recap cost attribution)
goals (id, name, type,            -- emergency_fund / debt_payoff / savings_target / investment_target / custom
       target_amount, current_amount, target_date,
       cadence_amount, cadence,   -- e.g. "save 800/month" style goals
       priority int, funding_account_id, status, created_at)
goal_links (id, goal_id, entity_type,             -- account / category / tag / liability / recurring_item
            entity_id, role,                      -- 'funding' / 'contribution_source' / 'cost_driver' / 'constraint'
            notes, created_at)                    -- the semantic map: which data areas this goal touches
goal_contributions (id, goal_id, transaction_id, amount, occurred_at)
goal_costs (id, goal_id, period_start, period_end, run_id,
            cost_type,                            -- 'interest_accrued' / 'fee' / 'penalty' / 'missed_discount' / 'opportunity'
            amount, liability_id,
            contributing_txn_ids uuid[],          -- exactly which transactions drove the cost
            computation jsonb,                    -- the math shown (balance carried, APR, days), fully auditable
            narrative text)

-- recaps & decision scoring
recaps (id, period_type,                          -- 'weekly' / 'monthly'
        period_start, period_end, run_id,
        scores jsonb,                             -- per-domain 0-100: cash_flow, budget_adherence,
                                                  --   goal_tradeoffs, credit_usage, investing
        overall_score numeric,
        goal_cost_summary jsonb,                  -- per-goal: contributed, true cost, net efficiency
        adjustments jsonb,                        -- recommended changes, each linkable to a recommendation row
        content_md text,                          -- rendered narrative
        created_at)

-- the agent
recommendations (id, created_at, run_id, type,   -- transfer / trade / prediction_position / alert / rebalance
                 summary text, rationale text,
                 payload jsonb,                   -- structured action: from, to, amount, symbol, side, qty, limits
                 confidence numeric,
                 status,                          -- pending / approved / rejected / executed / failed / expired
                 reviewed_at, executed_at, result jsonb)
agent_runs (id, started_at, finished_at, trigger, input_snapshot jsonb,
            model, tokens_used, status, error)
agent_config (id, autonomy_level int,             -- 0 read-only, 1 recommend, 2 approve-to-execute, 3 bounded auto
              max_txn_amount, max_daily_amount, max_open_positions,
              max_position_size, drawdown_halt_pct, allowed_action_types text[],
              updated_at)

-- self improvement (intentionally loose schema, SIE agent defines semantics)
si_entries (id, created_at, source,               -- 'manual' / 'file_import' / 'sie_agent' / 'api'
            category text,                        -- free-form, SIE agent's taxonomy
            title text, body text,
            metrics jsonb,                        -- arbitrary key/value numbers for charting
            tags text[], payload jsonb,           -- anything else the SIE agent wants to attach
            occurred_at timestamptz)
si_imports (id, created_at, filename, source_path, format,  -- json/csv/md/txt
            row_count, status, error, raw_ref)    -- provenance for every import batch

-- safety
audit_log (id, at, actor,                         -- 'agent' / 'user' / 'executor' / 'system'
           action, entity, entity_id, detail jsonb)   -- append-only, no update/delete policies
circuit_breaker_events (id, at, rule, detail jsonb, resolved_at)
```

---

## 5. Dashboard UI Spec

Design intent: this is a command center, not a budgeting app. Dense, dark, data-forward. Distinct from Mint/Copilot pastels. One signature element: the **Approval Queue** as the centerpiece interaction, styled like a trade blotter where each AI recommendation is a card with rationale, confidence, and one-tap Approve / Reject.

### Pages

1. **Overview (`/`)**
   - Net worth headline with sparkline (30/90/365d toggle)
   - Accounts grid grouped by type, live balances, sync freshness indicator
   - Cash flow summary: income vs spend, current month vs trailing 3-month average
   - Goal progress rail: each goal as a compact progress bar with pace indicator (ahead / on pace / behind)
   - Pending recommendations badge count linking to the queue

2. **Approval Queue (`/queue`)** (the signature page)
   - Cards for each pending recommendation: type icon, plain-English summary, expandable rationale, exact payload preview (from account, to account, amount / symbol, side, qty, est. cost), confidence, expiry countdown
   - Approve / Reject with confirm. Approve writes status change; executor picks it up. Realtime status transitions visible on the card (approved → executing → executed, with result)
   - History tab: every past recommendation and outcome, filterable

3. **Goals (`/goals`)**
   - **Goal creation wizard** that builds the semantic linkage powering recap cost attribution. Steps: (1) define the goal (type, target or cadence like "save $800/month", date, priority); (2) link data areas via `goal_links`: funding accounts, categories/tags that count as contributions, and crucially **cost drivers**: liabilities (credit cards, loans) and recurring items whose costs should be attributed against this goal when they're incurred while pursuing it; (3) preview: the wizard shows what last month's recap *would* have said for this goal using historical data, so the linkage is verifiably correct before saving
   - Per-goal detail view: contribution history (auto-matched transactions via links, manual attach supported), pace vs target, and a **true cost panel**: every `goal_costs` row with its full computation expanded (balance carried, APR, day count, the exact contributing transactions), so nothing is a black box
   - Net efficiency headline per goal: contributed amount, minus attributed costs, equals net progress, with a plain-English tradeoff line (e.g. "Hitting $800 saved this month required carrying a card balance that cost $37 in interest; net $610")
   - Priority ordering via drag; AI commentary from the latest run

4. **Budget (`/budget`)**
   - Both budgeting styles, switchable: **category mode** (limit per category, grouped by category groups, group-level or per-category budgeting per the group's `budget_mode`) and **flex mode** (fixed / flexible / non-monthly buckets with one headline "flexible remaining" number)
   - Rollover balances rendered inline on rollover-flagged categories, with the carried amount visible
   - "Auto-fill from trailing 6-month averages" action on first setup and a Recalculate button thereafter; every line hand-editable, budgets adjustable per individual month
   - Left-to-spend headline (budgeted income minus budgeted expenses), pace bars per category (spent vs elapsed month), overspend highlighted
   - Improvement over Monarch: an "Ask the agent" action per category that generates a specific recommendation (raise/lower this budget, and why, from real history)

5. **Recurring (`/recurring`)**
   - Auto-detected recurring transactions and subscriptions (detection job scores merchant + cadence + amount regularity)
   - Calendar and list views of upcoming expected charges; monthly recurring total headline
   - Status flags surfaced loudly: price increased, charge missed, new subscription detected
   - **Subscription context cards:** per subscription, editable fields for *purpose* (what it accomplishes), *value notes* (usage frequency, doubts, why it's worth it), and *overlap tags* (capability tags like ai_coding, storage, design). This user-supplied context is the fuel for the monthly recap's subscription review, so a gentle nudge prompts filling it in when a new subscription is detected
   - Review history per subscription: past verdicts and what was decided
   - **Red-flag actions:** flag any recurring item as fraud or cancelled-should-not-charge, adding it to the vendor watchlist; a watchlist strip at the top shows active flags and recent hits with their dispute status
   - One-tap "flag for cancellation review" which files an alert-type recommendation into the queue

6. **Investments (`/invest`)**
   - Alpaca positions table, P&L, allocation donut
   - Kalshi positions with current implied probability vs entry
   - Paper/live mode banner, always visible, color-coded (paper = blue, live = red header stripe)
   - Beyond Monarch (their weakest area): asset allocation breakdown, cost-basis and fee awareness, and per-position agent commentary, all first-party from the Alpaca connection rather than aggregator data

7. **Transactions (`/transactions`)**
   - Full searchable/filterable table (merchant, category, tag, account, amount range, date), inline category editing, bulk edit, split transactions, notes
   - **Unified feed including anticipated transactions:** ghost-styled rows from email receipts render instantly among real transactions with an "anticipated" badge, attributed card (from receipt last-four), and a countdown-to-expiry. Unverified-vendor rows carry approve / reject / edit-vendor-info actions, where editing (including pasting the pending descriptor from the card app) pre-seeds the vendor signature before the charge posts. On reconciliation the row visibly solidifies, already categorized with receipt attached. Medium-confidence reconciliations surface as one-tap "Is X the same as Y?" prompts whose answers persist permanently. Expired anticipations surface in the review inbox flagged as possible refund/cancellation/fraud
   - **Review inbox tab:** only transactions flagged `needs_review` by rules or low-confidence LLM categorization; inbox-zero flow with one-tap accept/correct. Every correction upserts `merchant_map` so it never asks about that merchant again
   - **Rules manager:** create/edit priority-ordered rules with criteria and actions per the pipeline spec in 1.6; "apply retroactively" runs a rule across history with a preview diff before commit
   - Tags manager; hidden transactions view
   - Category source badge on every transaction (plaid / rule / map / llm / user) for trust and debugging
   - **Business tab:** all business-tagged transactions grouped by entity, with a suggestion inbox for AI-detected likely business expenses on personal accounts (accept / dismiss), a missing-receipts counter with per-transaction upload (drag/drop or photo), receipt thumbnails inline, waive option, and entity/category/date-range filtering that feeds the tax export in Reports
   - **Email receipts sub-tab:** auto-matched receipts from Aldyn/Gmail shown with their linked transactions, the ambiguous-match queue with one-tap candidate resolution, unmatched receipts awaiting late-posting transactions, and a deep link back to the source email in Aldyn per receipt

8. **Reports (`/reports`)**
   - Cash flow Sankey (income sources → category groups → categories), spending and income summaries
   - Custom report builder: any combination of category/tag/account/timeframe, savable to `saved_reports`
   - Month-over-month and year-over-year comparisons; net worth history from snapshots
   - **Recaps tab (weekly + monthly):** each recap shows (a) decision scores 0-100 across five domains (cash flow, budget adherence, goal tradeoffs, credit usage, investing) with an overall score and trend vs prior periods; (b) the **goal cost callouts**: per goal, what was contributed, what it truly cost to get there (interest accrued, fees, missed discounts), the exact contributing transactions listed, and net efficiency; (c) recommended adjustments, each one actionable: accepting files it as a recommendation in the Approval Queue (e.g. "lower the savings cadence to $650 and clear the card balance first, saving ~$34/month in interest"); (d) the standard recap content: spend drivers, cash flow trend, subscription changes, net worth movement. Monthly recaps roll up the weeklies and score the month's decisions as a whole, and add a **Subscription Review section**: every active subscription evaluated against its user-written purpose, value notes, and overlap tags, with a verdict per subscription (keep / replace / cut / watch), reasoning, a concrete alternative where applicable (an existing tool already paid for that covers the same capability, a cheaper tier, or a new tool), and projected monthly savings from actual observed prices. Verdicts render as decision cards: accept files a cancellation/downgrade recommendation into the queue, reject records the decision so the same verdict isn't re-litigated next month, defer resurfaces it. A "total addressable savings" headline sums the accepted and pending verdicts
   - The latest recap also renders as an Overview dashboard widget with score + top callout

9. **Agent (`/agent`)**
   - Autonomy level control (0 to 3) with explicit descriptions of what each level permits
   - Guardrail settings: per-txn cap, daily cap, position limits, drawdown halt
   - **Notification rules:** spend-threshold and vendor-match alerts ("did I just spend over $X", "any charge from Y"), per-account variants, channel selection; these fire at anticipation creation, i.e. at email speed
   - Run history with token usage and input snapshots
   - Circuit breaker status and event log
   - "Run analysis now" button

10. **Self Improvement (`/self`)**
   - Purpose: a flexible personal-development section alongside the finance views. Deliberately loose by design: the owner's separate SIE agent will define the taxonomy and fill in richer structure later, so build the container, not the opinions.
   - Ingest paths (all local-friendly):
     - **Drop folder:** a watched local directory (e.g. `~/finance-app/si-inbox/`) where the owner or the SIE agent drops JSON/CSV/Markdown files; the worker detects, parses into `si_entries`, records the batch in `si_imports`, and archives the file
     - **Local API endpoint:** `POST /api/si/entries` on localhost so the SIE agent (or any local script) can write entries programmatically
     - **Manual quick-add** in the UI
   - Views: reverse-chron entry feed with tag/category filters, a metrics panel that auto-charts any numeric keys found in `metrics` jsonb over time, and an imports tab showing batch provenance and any parse errors
   - Keep it fully decoupled from the finance agent for now: nothing in `si_entries` feeds the financial recommendation engine unless explicitly wired later

11. **Audit (`/audit`)**
   - Append-only log viewer. Everything the system ever did.

### UI stack

Next.js App Router, Tailwind, shadcn/ui for primitives, Recharts for charts, Supabase Realtime subscriptions on `recommendations` and `accounts`. Mobile responsive: Overview and Queue must work perfectly on a phone since approvals will happen from anywhere.

---

## 6. Phase Plan

Each phase ships independently and is fully usable before the next begins. Do not start a phase until the previous phase's acceptance criteria pass.

### Phase 0: Foundation, Local (est. 1-2 sessions)

- Monorepo scaffold; `supabase init` + `supabase start` local stack (Docker); auth (single user, email + TOTP 2FA); all migrations from Section 4 including `si_entries`/`si_imports`; RLS policies; `.env.local` secrets pattern; worker skeleton under pm2 with health-check heartbeat rows; startup script so Docker stack + workers + web app all come back after a reboot.
- No Vercel, Render, or hosted Supabase in this phase. Everything runs and persists on the local machine.
- **Accept:** the owner can log in at `localhost`, empty dashboard renders, worker heartbeat visible in DB, full stack survives a reboot via the startup script.

### Phase 1: Read Everything (est. 2-4 sessions)

- Plaid Link flow in the dashboard (sandbox first, then limited production keys)
- Sync worker: initial backfill + incremental sync via webhooks and 6h cron for transactions, balances, investments, liabilities
- Overview, Transactions, and account pages fully live with real data
- **Categorization pipeline v1** (per Section 1.6 spec): seed default category groups/categories (Monarch-style set of roughly 60, with emoji, rollover and exclude flags), Plaid PFC v2 baseline mapping, priority-ordered rules engine with retroactive apply + preview diff, merchant map learning from every manual correction, review inbox
- Transactions page fully live including rules manager, tags, splits, bulk edit, hidden transactions
- **Recurring detection v1:** cadence/amount scoring job, `/recurring` page, price-change and missed-charge flags
- **Business layer v1:** `is_business` + `business_entity` flags on accounts set during linking, automatic business stamping of all transactions on flagged accounts, Business tab with manual receipt upload to local storage and `receipt_status` tracking
- Net worth snapshotting (daily cron writes a snapshot row for the sparkline)
- Self Improvement section v1: `/self` page, drop-folder watcher, `POST /api/si/entries` localhost endpoint, manual quick-add, entry feed and imports tab. (Metrics auto-charting can land here or in Phase 2, whichever is convenient.)
- **Accept:** all of the owner's real institutions linked, balances match reality, categorization pipeline resolves the large majority of transactions without touch, a manual correction is never re-asked for the same merchant, recurring page lists real subscriptions, net worth chart populates, a test file dropped in the SI inbox appears as entries in the UI.

### Phase 2: The Brain, Read-Only (est. 2-4 sessions)

- **Budgets:** both styles (category and flex with fixed/flexible/non-monthly buckets), rollover balances, auto-fill from trailing 6-month averages with recalculate, per-month adjustments, pace bars and overspend alerts
- **LLM enrichment pass** joins the categorization pipeline: batched daily run resolves Uncategorized and mixed-basket merchants (Amazon/Costco/Target problem) with confidence thresholds; low confidence routes to the review inbox
- **Business suggestion engine v1:** the same daily pass scores personal-account transactions for business likelihood, files `business_suggestions`, and accepted suggestions auto-request receipts; dismissed merchants are suppressed from future suggestions
- **Email receipt ingestion, Path B (Gmail):** Google OAuth (gmail.readonly, localhost redirect), tight-loop ingest worker (30-60s poll) pulling Aldyn-labeled receipt emails, parser into `email_receipts`, the matching engine per Section 1.7 (auto-match, ambiguous queue, 90-day retention), matched receipts satisfying business receipt requests and feeding item lines
- **Anticipation engine (Section 1.7):** permissive anticipation on every legitimacy-verified receipt (sender DKIM/SPF + vendor-domain gate is the only hard filter), card attribution via receipt last-four against account masks, unverified-vendor rows with approve/reject/pre-fill actions, scored reconciliation (amount + semantic name + date + last-four) with the "Is X the same as Y?" clarification flow persisting aliases to `vendor_signatures`, 14-day expiry review, and receipt-driven spend notifications via `notification_rules` at anticipation time
- **Parallel workstream, Path A (Aldyn Receipts API):** build the Section 1.7 endpoint on the Aldyn side whenever convenient; the finance-app poller for it is a thin sibling of the Gmail ingester behind the same `email_receipts` table, and Gmail Path B is switched off once Path A runs clean for a couple of weeks
- **Vendor red-flag watchlist:** fraud/cancelled flags with signature-based matching, checks wired into all four ingress points (receipt ingest, anticipation, Plaid sync, recurring detection), instant red-alert notification + auto-filed dispute/refund queue item on any hit, flag entry from transactions, recurring items, expired anticipations, and confirmed subscription-review cuts
- Business tax export in Reports: business expenses by entity/category/date range with receipt references
- **Reports:** Cash flow Sankey, spending/income summaries, custom saved reports, MoM/YoY comparisons
- **Goal creation wizard + semantic linkage:** goals CRUD, `goal_links` mapping (funding accounts, contribution categories/tags, cost-driver liabilities and recurring items), auto-matching of contribution transactions, pace and funding-gap math, and the wizard's historical preview so linkages are validated against real data at creation time
- Agent worker v1: assembles financial state snapshot, calls Claude with a structured system prompt, receives strict-JSON recommendations, validates with zod, writes `alert` and advisory-type recommendations only (no executable payloads yet)
- Approval Queue UI live in advisory mode (recommendations are informational, "Acknowledge" instead of "Approve")
- Daily scheduled run + manual run button
- **Recap engine (weekly + monthly), the flagship analysis feature.** Two-stage design, non-negotiable:
  - **Stage 1, deterministic math (worker, no LLM):** computes every number. Cost attribution per goal from `goal_links`: for each cost-driver liability, interest accrued during the period is computed from carried balance, APR, and day count, then attributed to goals whose contributions coincided with carrying that balance, with the exact contributing transactions captured in `goal_costs.contributing_txn_ids` and the full math stored in `computation`. Also computes fees, budget adherence, cash flow deltas, credit utilization, and net-efficiency per goal.
  - **Stage 2, LLM scoring + narrative:** Claude receives Stage 1's numbers and scores decisions 0-100 per domain (cash flow, budget adherence, goal tradeoffs, credit usage, investing), writes the narrative and tradeoff callouts, and proposes adjustments as structured objects. Hard rule: the model may only reference numbers provided by Stage 1, never compute or invent figures. Adjustments the user accepts convert into Approval Queue recommendations.
  - Weekly recap runs Sunday night; monthly rolls up weeklies and scores the month. Both render in the Reports Recaps tab and the Overview widget.
  - **Subscription review (monthly recap only):** Stage 1 supplies the subscription roster with observed prices, price-change history, user-written purpose/value/overlap context, and an overlap matrix (subscriptions sharing capability tags). Stage 2 issues per-subscription verdicts (keep / replace / cut / watch) with reasoning grounded in that context, concrete alternatives (prioritizing tools the owner already pays for that cover the same capability), and projected savings computed only from Stage 1 prices. Optionally, the worker may run a web search step for current alternative pricing before Stage 2, with fetched prices entering Stage 1 data so the no-invented-numbers rule holds. Prior decisions are honored: rejected verdicts aren't re-raised without a material change (price increase, new overlap).
- **Accept (recap-specific):** given a test month where a savings goal is hit while a linked credit card carries a balance, the recap correctly states the interest cost to the cent against the card statement, lists the exact contributing transactions, and the adjustment recommendation's projected savings matches hand-checked math.
- **Accept:** daily run produces sensible, correctly grounded recommendations referencing real numbers; budget math matches hand-checked figures including rollovers; Sankey renders from real data; malformed model output is rejected and logged, never displayed raw.

*As built (2026-08-04), Reports / Goals / enrichment / recap:*

- **The no-invented-numbers rule is enforced, not requested.** `verifyGrounding` (in `packages/shared/src/recap.ts`) extracts every numeric token from the model's narrative, adjustment titles and rationales, and subscription reasoning, and requires each to match a number Stage 1 produced within a cent or a rounding step. The only allowances are the model's own 0–100 scores, four-digit years, and integers up to 12. A single unsourced figure fails the whole run: `agent_runs.status = failed` with the offending values in `error`, no recap row is written, and the Recaps tab shows the rejection rather than anything partial. Verified against a live run: 47 figures traced back to Stage 1, and a deliberately derived figure ("income minus spending came to $3,210.45") is rejected.
- **Cost attribution has an explicit rule.** Interest on a linked liability is charged against a goal only if the owner also contributed to that goal during the period. Carrying a balance while contributing nothing is a credit problem, not a goal cost, and conflating the two would make every goal look expensive.
- **The Sankey has a hub node.** Income sources flow into a single "Cash in" node before spending groups, rather than income sources connecting to groups directly. Dollars are fungible — nothing in the data says which paycheck paid the electric bill — so direct edges would draw an attribution the data does not support.
- **A monthly recap compares against the previous calendar month**, not the previous 31 days, so "last month" means what a bank statement means. Weekly recaps compare against the preceding week.
- **Enrichment protects the merchant map.** Only single-purpose merchants at ≥0.92 confidence write back to `merchant_map`; the mixed-basket list (Amazon, Costco, Target, Walmart, warehouse clubs, pharmacies, marketplaces) is excluded by name, since learning "Amazon = Shopping" once is precisely the failure §3.5 exists to avoid. Rows the model calls ambiguous are flagged for review with its reason and are not re-sent on later runs.
- **The goals wizard's preview replays real history.** Step three runs the same `matchContributions` the nightly worker runs, over six months of actual transactions, and shows the resulting contributions, collapsed duplicate legs, and cost math before the goal is saved. Both legs of a transfer collapse to one contribution; a manual attachment always wins over the auto-matcher.

### Phase 3: Human-Approved Execution (est. 3-5 sessions)

- **3a: Paper trading.** Alpaca paper account linked. Agent may emit `trade` recommendations with full payloads. Approve triggers executor, which re-validates guardrails and places the paper order. Investments page live. Run in paper mode for a minimum of 30 days.
  - The agent's output schema is narrowed to what is switched on: with trading off it is not given the vocabulary to express a trade at all. A rule the model cannot express is worth more than a rule in the prompt telling it not to.
  - The agent never chooses the account. Exactly one account may be flagged `is_agent_controlled`; code resolves it and stamps it into the payload, and two flagged accounts disable trading rather than making the agent pick.
  - A proposal is dry-run against the *same* `checkGuardrails` the executor uses, hypothesising approval and autonomy 2, before it is written. The queue then only offers Approve on an order that could actually go through, and the executor still decides again at execution time against a world that has moved.
  - Grounding admits one exception: the proposed order size. It is the model's own proposal about the future, not a claim about the owner's past, and it is judged in dollars by the guardrails rather than by whether it appears in the snapshot. Every figure in the rationale is still held to the rule.
- **3b: Kalshi demo.** Same flow against Kalshi's demo environment for `prediction_position` recommendations.
- **3c: Transfers.** Astra (or Alpaca ACH for brokerage funding) integration for `transfer` recommendations between the owner's own accounts, always approval-gated. Start with a tiny cap ($50) and raise deliberately.
- Executor hard rules regardless of approval: reject if amount exceeds caps, if daily total would exceed cap, if account is not flagged agent-eligible, if recommendation is older than its expiry.
- Full audit logging of every execution attempt and result.
- **Accept:** 30 days of paper trading with zero guardrail violations, transfer round-trip of a small real amount succeeds and logs correctly, every execution visible in Audit.

### Phase 4: Bounded Autonomy (est. 2-3 sessions)

- Autonomy level 3 unlocks auto-execution ONLY for: recommendation types explicitly allow-listed in `agent_config`, amounts under the per-txn cap, within daily cap, on the agent-controlled sub-account only
- Everything above thresholds still queues for approval, permanently
- Circuit breakers live: drawdown halt (pause all auto-execution if agent-controlled account drops X% in 7 days), velocity halt (max N auto-executions/day), failure halt (2 consecutive execution failures pauses the agent)
- Push notifications (start with email via Supabase, or ntfy.sh) for every auto-execution and every breaker trip
- Weekly agent performance report: what it did, outcomes, vs baseline of doing nothing
- **Accept:** one full week of bounded autonomy on small caps with correct notifications, then deliberately trip each circuit breaker in a test and confirm halts.

### Phase 2.1: Drill-down (small, continuous)

Refinements that only became obvious once the platform ran on real data. Each
is small enough to land without a phase of its own.

- **Budget line drill-down.** Clicking a budget category opens the transactions
  behind that figure, for that month, without leaving the page. A budget number
  is an assertion — "you spent $820 on Shopping" — and the only way to trust or
  correct it is to see what it is made of. Every miscategorisation found so far
  was found by asking that question, and until now answering it meant going to
  Transactions and rebuilding the same filters by hand. The panel counts each
  dollar exactly once the way the budget does (a split hides its parent, so
  `hidden = false` alone), and offers the same query as a Transactions link for
  when editing is what is actually wanted.

- **Net worth history is discontinuous when accounts are linked.** Linking six
  more credit cards on one day moved the series down by roughly the balance
  those cards carried, and the agent duly reported a plunge. No debt was
  incurred; it
  became visible. A snapshot records a total without recording which accounts it
  was a total *of*, so nothing downstream can tell "you spent this" from "you
  can now see this." The fix is to store the account set alongside the total and
  treat a change in that set as a discontinuity rather than a movement — both in
  the chart and in what the agent is allowed to call a trend.

### Phase 5 (later, optional)

- **Hosted migration:** promote to hosted Supabase + Vercel + Render when the owner wants access away from the machine. Same migrations, swap env values, enable Plaid webhooks, move secrets to Vault. The local build's structure makes this a config exercise, not a rewrite.
- **Desktop app packaging:** graduate the Phase-0 desktop integration (app-menu launcher, Chrome app-mode window, PWA manifest, and the "Life Command" system-tray controller v0 with live status + start/stop menu) into a full desktop app: pending-approval badge count on the tray icon, a native Tauri shell, and native desktop notifications wired to `notification_rules`. The user-facing product name is **Life Command** (services/packages keep `finance-*` names). Target: a distributable build others can clone/run — no personal data or secrets in the repo, everything instance-specific via env/config.
- Receipt ingestion (photo or email-forward parsing into `item_lines` for item-level categorization of mixed baskets)
- Monarch/Mint CSV import for historical data backfill and category mapping
- Scenario forecasting (model a home purchase, income change, or big goal side-by-side against baseline)
- Strategy backtesting harness against Alpaca historical data before any strategy goes live
- Tax lot awareness and year-end export
- Bill negotiation / subscription detection recommendations
- Scenario modeling ("what if I move $X/mo to the brokerage")
- Per-function model selector in UI settings: pick the Claude model for each LLM function (agent analysis, enrichment, recap scoring, subscription reviews) instead of env-level defaults

---

## 7. Security Requirements (non-negotiable, all phases)

1. All external API keys in gitignored `.env.local` files while local (Supabase Vault at hosted migration), read only by workers server-side. The browser never sees any key. Never commit env files.
2. Auth: single allow-listed user ID, TOTP 2FA required, RLS on every table.
3. Executor validates guardrails from `agent_config` at execution time. Prompt-level instructions to the model are NOT a security boundary.
4. `audit_log` is append-only: no UPDATE or DELETE grants to any role the app uses.
5. Plaid access tokens encrypted at rest (Vault), item-level, revocable from the dashboard.
6. Live-mode anything (live Alpaca keys, real Astra transfers, live Kalshi) requires a manual environment flag flip plus a confirmation in the UI. Paper/demo is the default everywhere.
7. Anthropic API calls: send derived financial state, not raw credentials or account numbers. Mask account identifiers to last-4 in prompts.

---

## 8. Agent Prompt Contract (for the agent worker)

The system prompt to Claude must enforce:

- Role: personal financial analyst for a single user. Output ONLY a JSON array of recommendation objects matching the provided schema. No prose outside JSON.
- Inputs provided each run: account summaries, 90-day cash flow aggregates, goal states with pace math, current holdings with P&L, current guardrail config, last 10 recommendations and their outcomes (so it learns what was rejected).
- Every recommendation requires: `type`, `summary` (one sentence, plain English), `rationale` (references the specific numbers driving it), `payload` (exact executable parameters or null for alerts), `confidence` (0-1), `expires_at`.
- The model must never propose actions exceeding current guardrail config; the executor rejects them anyway, but proposals that would be rejected count against the model in the run log.

**Recap runs (additional contract):**
- Inputs: the full Stage 1 deterministic output (goal contributions, `goal_costs` rows with computations, budget adherence, cash flow deltas, credit utilization, net efficiency per goal), plus the prior two recaps for trend continuity.
- Outputs: `scores` per domain with one-sentence justification each citing specific Stage 1 numbers, `overall_score`, narrative markdown, and `adjustments` as structured objects (each with projected impact drawn from Stage 1 figures).
- Absolute rule: every number in the narrative must appear in Stage 1 input. The renderer validates this; a recap containing an unsourced figure is rejected and the run marked failed.

---

## 9. Environment & Keys Checklist (for the owner, before Phase 1)

- [ ] Plaid: create developer account, get sandbox keys, apply for limited production
- [ ] Anthropic API key
- [ ] Alpaca: open individual account, generate PAPER keys first
- [ ] Kalshi: create account, generate demo API key (RSA keypair)
- [ ] Astra: developer signup (needed at Phase 3c, can defer)
- [ ] Google Cloud Console project: OAuth client (Web) with localhost redirect URI, gmail.readonly scope, the owner's account added as test user (needed at Phase 2 for email receipts)
- [ ] Aldyn: decide auth scheme for the Receipts API and generate the finance app's API key (needed whenever Path A is built)
- [ ] Docker Desktop installed and running (required for the Supabase local stack)
- [ ] Node 20+, pnpm or npm, Supabase CLI installed
- [ ] pm2 installed globally (worker process management + reboot persistence)
- [ ] (Deferred to hosted migration: hosted Supabase project, Render, Vercel)

---

## 10. Open Questions to Resolve During Build

1. Plaid limited production approval timeline: build entirely on sandbox in parallel so this never blocks.
2. Astra personal-app eligibility: verify at Phase 3c; fallback is Alpaca-native ACH for the brokerage leg and manual transfers elsewhere.
3. Worker language: Node keeps one language across the repo; Python has better quant/backtesting libraries. Recommendation: Node for sync/executor, add a Python service only if Phase 5 backtesting demands it.
4. Which real account becomes the agent-controlled sub-account: recommend opening a fresh dedicated checking or using the Alpaca cash balance as the sandbox for autonomy.

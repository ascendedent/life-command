import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlaidApi, Transaction as PlaidTxn } from "plaid";
import {
  audit,
  plaidError,
  decryptSecret,
  categorizeTransaction,
  merchantKey,
  type CategorizeContext,
  type TxnRule,
  type MerchantMapEntry,
} from "@finance/shared";
import { snapshotNetWorth } from "./networth.js";

interface InstitutionRow {
  id: string;
  name: string;
  plaid_item_id: string;
  access_token_enc: string;
  transactions_cursor: string | null;
}

/**
 * Plaid errors that mean "ask again shortly", not "this link is broken".
 * PRODUCT_NOT_READY is the common one: it is what a brand-new Item returns
 * while Plaid is still pulling history, so it fires on nearly every first sync.
 */
const TRANSIENT_PLAID_ERRORS = new Set([
  "PRODUCT_NOT_READY",
  "RATE_LIMIT_EXCEEDED",
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
]);
const MAX_TRANSIENT_RETRIES = 6;

interface AccountRow {
  id: string;
  plaid_account_id: string;
  type: string;
  mask: string | null;
  is_business: boolean;
  business_entity: string | null;
}

export async function loadCategorizeContext(
  db: SupabaseClient
): Promise<CategorizeContext> {
  const [{ data: rules }, { data: mapRows }, { data: cats }] = await Promise.all([
    db.from("txn_rules").select("id, priority, criteria, actions")
      .eq("is_active", true).order("priority"),
    db.from("merchant_map").select("raw_pattern, clean_name, default_category_id"),
    db.from("categories").select("id, name"),
  ]);
  const merchantMap = new Map<string, MerchantMapEntry>();
  for (const r of mapRows ?? []) {
    merchantMap.set(r.raw_pattern, {
      clean_name: r.clean_name,
      default_category_id: r.default_category_id,
    });
  }
  const categoryIdByName = new Map<string, string>();
  for (const c of cats ?? []) categoryIdByName.set(c.name, c.id);
  const uncategorizedId = categoryIdByName.get("Uncategorized");
  if (!uncategorizedId) throw new Error("Uncategorized category missing — run migrations");
  return {
    rules: (rules ?? []) as TxnRule[],
    merchantMap,
    categoryIdByName,
    uncategorizedId,
  };
}

function txnRow(
  t: PlaidTxn,
  account: AccountRow,
  ctx: CategorizeContext
): Record<string, unknown> {
  const cat = categorizeTransaction(
    {
      merchant: t.merchant_name ?? t.name,
      amount: t.amount,
      account_id: account.id,
      pfc_primary: t.personal_finance_category?.primary ?? null,
      pfc_detailed: t.personal_finance_category?.detailed ?? null,
    },
    ctx
  );
  const isBusiness = account.is_business;
  return {
    account_id: account.id,
    plaid_txn_id: t.transaction_id,
    date: t.date,
    amount: t.amount,
    merchant: t.merchant_name ?? t.name,
    // Keep the bank descriptor even when a tidy merchant_name exists — it is
    // what disambiguates "Walmart" the payment from "Walmart" the groceries.
    description: t.name,
    merchant_clean: cat.merchant_clean,
    category_id: cat.category_id,
    category_source: cat.category_source,
    plaid_category_primary: t.personal_finance_category?.primary ?? null,
    plaid_category_detail: t.personal_finance_category?.detailed ?? null,
    pending: t.pending,
    hidden: cat.hidden,
    needs_review: cat.needs_review,
    is_business: isBusiness,
    business_source: isBusiness ? "account_default" : null,
    business_entity: isBusiness ? account.business_entity : null,
    receipt_status: isBusiness ? "requested" : null,
    raw: t as unknown as Record<string, unknown>,
  };
}

async function syncInstitution(
  db: SupabaseClient,
  plaid: PlaidApi,
  inst: InstitutionRow,
  ctx: CategorizeContext
): Promise<{ added: number; modified: number; removed: number }> {
  const token = decryptSecret(inst.access_token_enc);

  // --- accounts & balances --------------------------------------------------
  const accountsRes = await plaid.accountsGet({ access_token: token });
  for (const a of accountsRes.data.accounts) {
    await db.from("accounts").upsert(
      {
        institution_id: inst.id,
        plaid_account_id: a.account_id,
        name: a.name,
        type: a.type,
        subtype: a.subtype ?? null,
        mask: a.mask ?? null,
        current_balance: a.balances.current,
        available_balance: a.balances.available,
      },
      { onConflict: "plaid_account_id" }
    );
  }
  const { data: accountRows } = await db
    .from("accounts")
    .select("id, plaid_account_id, type, mask, is_business, business_entity")
    .eq("institution_id", inst.id);
  const accountsByPlaidId = new Map<string, AccountRow>();
  for (const a of accountRows ?? []) accountsByPlaidId.set(a.plaid_account_id, a);

  // --- transactions (cursor-based sync) ------------------------------------
  let cursor = inst.transactions_cursor ?? undefined;
  let added = 0, modified = 0, removed = 0;
  let hasMore = true;
  while (hasMore) {
    const res = await plaid.transactionsSync({
      access_token: token,
      cursor,
      count: 500,
    });
    const d = res.data;

    for (const t of d.added) {
      const account = accountsByPlaidId.get(t.account_id);
      if (!account) continue;
      const { data: inserted, error } = await db
        .from("transactions")
        .upsert(txnRow(t, account, ctx), { onConflict: "plaid_txn_id" })
        .select("id, merchant, amount, date, account_id")
        .single();
      if (error) {
        console.error(`[sync] insert ${t.transaction_id}: ${error.message}`);
        continue;
      }
      added++;
      // reconcile against open anticipations + watchlist (spec §1.7.4)
      try {
        const { reconcileNewTransaction } = await import("./reconcile.js");
        await reconcileNewTransaction(
          db,
          { ...inserted, amount: Number(inserted.amount) },
          account.mask
        );
      } catch (e: unknown) {
        console.error(`[sync] reconcile failed:`, (e as Error).message);
      }
    }

    for (const t of d.modified) {
      const account = accountsByPlaidId.get(t.account_id);
      if (!account) continue;
      const { data: existing } = await db
        .from("transactions")
        .select("id, category_source")
        .eq("plaid_txn_id", t.transaction_id)
        .maybeSingle();
      if (!existing) {
        await db.from("transactions").upsert(txnRow(t, account, ctx), {
          onConflict: "plaid_txn_id",
        });
        modified++;
        continue;
      }
      // Never clobber user/rule/map categorization on modify — update the
      // bank-side fields only; re-run the pipeline only for plaid-sourced rows.
      const base: Record<string, unknown> = {
        date: t.date,
        amount: t.amount,
        pending: t.pending,
        merchant: t.merchant_name ?? t.name,
        plaid_category_primary: t.personal_finance_category?.primary ?? null,
        plaid_category_detail: t.personal_finance_category?.detailed ?? null,
        raw: t as unknown as Record<string, unknown>,
      };
      if (existing.category_source === "plaid") {
        Object.assign(base, txnRow(t, account, ctx));
      }
      await db.from("transactions").update(base).eq("id", existing.id);
      modified++;
    }

    for (const r of d.removed) {
      await db.from("transactions").delete().eq("plaid_txn_id", r.transaction_id);
      removed++;
    }

    cursor = d.next_cursor;
    hasMore = d.has_more;
  }

  // --- investments ----------------------------------------------------------
  const investmentAccounts = (accountRows ?? []).filter((a) => a.type === "investment");
  if (investmentAccounts.length > 0) {
    try {
      const inv = await plaid.investmentsHoldingsGet({ access_token: token });
      const securities = new Map(
        inv.data.securities.map((s) => [s.security_id, s.ticker_symbol ?? s.name ?? "?"])
      );
      const ids = investmentAccounts.map((a) => a.id);
      await db.from("holdings").delete().in("account_id", ids);
      for (const h of inv.data.holdings) {
        const account = accountsByPlaidId.get(h.account_id);
        if (!account) continue;
        await db.from("holdings").insert({
          account_id: account.id,
          symbol: securities.get(h.security_id) ?? "?",
          quantity: h.quantity,
          cost_basis: h.cost_basis,
          market_value: h.institution_value,
          as_of: new Date().toISOString(),
        });
      }
    } catch (e: unknown) {
      console.error(`[sync] holdings for ${inst.name}:`, (e as Error).message);
    }
  }

  // --- liabilities ----------------------------------------------------------
  const liabilityAccounts = (accountRows ?? []).filter(
    (a) => a.type === "credit" || a.type === "loan"
  );
  if (liabilityAccounts.length > 0) {
    try {
      const liab = await plaid.liabilitiesGet({ access_token: token });
      // Upsert on (account_id, type), never delete-and-replace. Replacing gave
      // every liability a new id on every sync, which silently orphaned the
      // goal_links rows pointing at them — goal_links is polymorphic, so no
      // foreign key existed to catch it and goal cost attribution just stopped.
      const seen: { account_id: string; type: string }[] = [];
      for (const c of liab.data.liabilities.credit ?? []) {
        const account = c.account_id ? accountsByPlaidId.get(c.account_id) : null;
        if (!account) continue;
        // Every rate, not just one. A 0% promotional APR and a 26.99% cash
        // advance rate were both being discarded, and the promotional one is
        // what decides whether carrying a balance costs anything at all.
        const aprs = (c.aprs ?? []).map((x) => ({
          apr_type: String(x.apr_type),
          apr_percentage: x.apr_percentage ?? null,
          balance_subject_to_apr: x.balance_subject_to_apr ?? null,
          interest_charge_amount: x.interest_charge_amount ?? null,
        }));
        const apr = c.aprs?.find((x) => x.apr_type === "purchase_apr") ?? c.aprs?.[0];
        seen.push({ account_id: account.id, type: "credit" });
        await db.from("liabilities").upsert({
          account_id: account.id,
          type: "credit",
          aprs,
          apr: apr?.apr_percentage ?? null,
          minimum_payment: c.minimum_payment_amount ?? null,
          next_due_date: c.next_payment_due_date ?? null,
          balance: c.last_statement_balance ?? null,
        }, { onConflict: "account_id,type" });
      }
      for (const s of liab.data.liabilities.student ?? []) {
        const account = s.account_id ? accountsByPlaidId.get(s.account_id) : null;
        if (!account) continue;
        seen.push({ account_id: account.id, type: "student" });
        await db.from("liabilities").upsert({
          account_id: account.id,
          type: "student",
          apr: s.interest_rate_percentage ?? null,
          minimum_payment: s.minimum_payment_amount ?? null,
          next_due_date: s.next_payment_due_date ?? null,
          balance: null,
        }, { onConflict: "account_id,type" });
      }
      for (const m of liab.data.liabilities.mortgage ?? []) {
        const account = m.account_id ? accountsByPlaidId.get(m.account_id) : null;
        if (!account) continue;
        seen.push({ account_id: account.id, type: "mortgage" });
        await db.from("liabilities").upsert({
          account_id: account.id,
          type: "mortgage",
          apr: m.interest_rate?.percentage ?? null,
          minimum_payment: m.next_monthly_payment ?? null,
          next_due_date: m.next_payment_due_date ?? null,
          balance: null,
        }, { onConflict: "account_id,type" });
      }

      // Drop only what Plaid stopped reporting — a closed card — rather than
      // everything. Anything still present keeps the id it has always had.
      const keep = new Set(seen.map((s) => `${s.account_id}:${s.type}`));
      const { data: existingLiabs } = await db
        .from("liabilities")
        .select("id, account_id, type")
        .in(
          "account_id",
          liabilityAccounts.map((a) => a.id)
        );
      const stale = (existingLiabs ?? [])
        .filter((l) => !keep.has(`${l.account_id}:${l.type}`))
        .map((l) => l.id);
      if (stale.length) await db.from("liabilities").delete().in("id", stale);
    } catch (e: unknown) {
      // Non-fatal: not every issuer exposes liabilities for every Item.
      console.error(`[sync] liabilities for ${inst.name}: ${plaidError(e).summary}`);
    }
  }

  await db
    .from("institutions")
    .update({
      transactions_cursor: cursor ?? null,
      last_sync_at: new Date().toISOString(),
      status: "ok",
      last_error: null,
    })
    .eq("id", inst.id);

  return { added, modified, removed };
}

export async function runSync(
  db: SupabaseClient,
  plaid: PlaidApi,
  institutionId?: string
): Promise<void> {
  let q = db
    .from("institutions")
    .select("id, name, plaid_item_id, access_token_enc, transactions_cursor")
    .not("access_token_enc", "is", null);
  if (institutionId) q = q.eq("id", institutionId);
  const { data: institutions } = await q;
  if (!institutions?.length) {
    console.log("[sync] no linked institutions");
    return;
  }

  const ctx = await loadCategorizeContext(db);
  for (const inst of institutions) {
    try {
      const counts = await syncInstitution(db, plaid, inst as InstitutionRow, ctx);
      console.log(
        `[sync] ${inst.name}: +${counts.added} ~${counts.modified} -${counts.removed}`
      );
      await audit(db, "system", "sync_completed", "institutions", inst.id, counts);
    } catch (e: unknown) {
      const p = plaidError(e);

      // Plaid is still preparing the Item — the normal answer for the first
      // few minutes after linking. Back off and retry rather than declaring
      // the institution broken; the link itself is fine.
      if (p.error_code && TRANSIENT_PLAID_ERRORS.has(p.error_code)) {
        const { count } = await db
          .from("sync_jobs")
          .select("id", { count: "exact", head: true })
          .eq("institution_id", inst.id)
          .eq("requested_by", "system")
          .gte("requested_at", new Date(Date.now() - 3600_000).toISOString());
        const attempt = count ?? 0;

        if (attempt < MAX_TRANSIENT_RETRIES) {
          const delaySec = Math.min(60 * 2 ** attempt, 900); // 1min → 15min
          await db.from("sync_jobs").insert({
            type: "sync_item",
            institution_id: inst.id,
            requested_by: "system",
            attempts: attempt + 1,
            run_after: new Date(Date.now() + delaySec * 1000).toISOString(),
          });
          await db
            .from("institutions")
            .update({ status: "syncing", last_error: `${p.error_code} — retrying` })
            .eq("id", inst.id);
          console.log(
            `[sync] ${inst.name}: ${p.error_code}, retrying in ${delaySec}s (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES})`
          );
          continue;
        }
      }

      console.error(
        `[sync] ${inst.name} failed: ${p.summary}` +
          (p.request_id ? ` (request_id ${p.request_id})` : "")
      );
      await db
        .from("institutions")
        .update({ status: "error", last_error: p.summary })
        .eq("id", inst.id);
      await audit(db, "system", "sync_failed", "institutions", inst.id, {
        error: p.summary,
        error_code: p.error_code,
        error_type: p.error_type,
        request_id: p.request_id,
      });
    }
  }
  await snapshotNetWorth(db);
}

/** Claim and run one pending sync job, if any. Returns true if one ran. */
export async function pollSyncJobs(db: SupabaseClient, plaid: PlaidApi): Promise<boolean> {
  const { data: job } = await db
    .from("sync_jobs")
    .select("id, type, institution_id")
    .eq("status", "pending")
    // Honour backoff: a retry queued for later must not be claimed now.
    .or(`run_after.is.null,run_after.lte.${new Date().toISOString()}`)
    .order("requested_at")
    .limit(1)
    .maybeSingle();
  if (!job) return false;

  const { data: claimed } = await db
    .from("sync_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (!claimed) return false; // raced

  try {
    if (job.type === "agent_run") {
      const { runAgentAnalysis } = await import("./agent.js");
      await runAgentAnalysis(db, "manual");
    } else if (job.type === "goal_match") {
      const { matchGoalContributions } = await import("./goals.js");
      await matchGoalContributions(db);
    } else if (job.type === "enrich") {
      const { runEnrichment } = await import("./enrich.js");
      await runEnrichment(db, "manual");
    } else if (job.type === "recap_weekly" || job.type === "recap_monthly") {
      const { runRecap } = await import("./recap.js");
      await runRecap(db, job.type === "recap_weekly" ? "weekly" : "monthly");
    } else {
      await runSync(db, plaid, job.institution_id ?? undefined);
    }
    await db
      .from("sync_jobs")
      .update({ status: "done", finished_at: new Date().toISOString() })
      .eq("id", job.id);
  } catch (e: unknown) {
    await db
      .from("sync_jobs")
      .update({
        status: "error",
        finished_at: new Date().toISOString(),
        error: (e as Error).message,
      })
      .eq("id", job.id);
  }
  return true;
}

export async function syncTick(db: SupabaseClient, plaid: PlaidApi) {
  await runSync(db, plaid);
}

export { merchantKey };

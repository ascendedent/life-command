import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@finance/shared";
import { merchantKey } from "@finance/shared/src/categorize";

// LLM enrichment pass (spec §3.4 and §3.9.2). Runs daily, batched:
//   1. resolve transactions the deterministic pipeline left Uncategorized, plus
//      known mixed-basket merchants (the Amazon/Costco/Target problem);
//   2. score personal-account transactions for business likelihood.
// Nothing here executes anything: it writes categories, review flags and
// suggestion rows, all of which the owner can override.

const MODEL = process.env.ENRICH_MODEL ?? process.env.AGENT_MODEL ?? "claude-sonnet-5";

/** Above this we apply the category outright; below it goes to the review inbox. */
const AUTO_APPLY = 0.8;
/** Only a confident call on a single-purpose merchant is allowed to teach the map. */
const TEACH_MAP = 0.92;
/** Business suggestions below this are not worth interrupting the owner for. */
const SUGGEST_BUSINESS = 0.7;

const UNSURE_PREFIX = "LLM unsure:";

const BATCH = 40;
const MAX_PER_RUN = 200;

/**
 * Merchants whose baskets genuinely vary transaction to transaction. A category
 * learned from one of these must never be written back to merchant_map — that
 * is exactly the mistake that makes every Amazon order "Shopping" forever.
 */
const MIXED_BASKET = [
  "amazon", "amzn", "costco", "target", "walmart", "sams club", "bj's", "bjs wholesale",
  "kroger", "meijer", "cvs", "walgreens", "ebay", "etsy", "aliexpress", "temu",
];

const isMixedBasket = (merchant: string | null) =>
  !!merchant && MIXED_BASKET.some((m) => merchant.toLowerCase().includes(m));

const CategorizationSchema = z.object({
  ref: z.string().describe("The ref string from the input list, e.g. t3"),
  category: z.string().describe("Exactly one category name from the allowed list"),
  confidence: z.number().describe("0 to 1 — how sure you are for THIS transaction"),
  rationale: z.string().describe("One short clause explaining the call"),
});

const CategorizeOutput = z.object({
  results: z.array(CategorizationSchema),
});

const BusinessOutput = z.object({
  results: z.array(
    z.object({
      ref: z.string().describe("The ref string from the input list"),
      likelihood: z.number().describe("0 to 1 that this is a business expense"),
      rationale: z.string().describe("What signals drove the score"),
    })
  ),
});

const CATEGORIZE_SYSTEM = `You categorize bank transactions for a single-user personal finance platform.

Rules:
- Choose exactly one category name from the allowed list. Never invent a name.
- Amounts follow the platform convention: positive = money out, negative = money in.
- Confidence is per transaction. A general-merchandise store (Amazon, Target, Costco) with no other signal is genuinely ambiguous — say so with a low confidence rather than guessing "Shopping" at high confidence.
- Use the owner's own history of that merchant when it is provided; a merchant they have consistently categorized one way is strong evidence.
- Return one result per input transaction, no more.`;

const BUSINESS_SYSTEM = `You score personal-account transactions for the likelihood that they are business expenses, for a single-user finance platform whose owner runs a business alongside personal spending.

Signals that raise likelihood: SaaS and developer tools, advertising platforms, contractor or freelancer payments, shipping and postage, domain and hosting, business travel patterns, wholesale supply purchases, professional services.
Signals that lower it: groceries, restaurants without a pattern, personal care, entertainment, household goods, anything matching ordinary household rhythm.

Rules:
- Be conservative. A false positive costs the owner an audit risk; a false negative costs them nothing but a manual tag.
- Score per transaction, 0 to 1. Return one result per input transaction.
- The owner's confirmed business spending is provided as context when available — similarity to it is the strongest signal you have.`;

interface TxnLite {
  id: string;
  date: string;
  amount: number;
  merchant: string | null;
  merchant_clean: string | null;
  category_id: string | null;
  account_id: string;
  plaid_category_primary: string | null;
  plaid_category_detail: string | null;
}

function client() {
  return new Anthropic();
}

/**
 * Categorize what the deterministic pipeline could not.
 * Returns how many transactions were touched.
 */
async function enrichCategories(
  db: SupabaseClient,
  runId: string
): Promise<{ applied: number; flagged: number; considered: number }> {
  const { data: cats } = await db
    .from("categories")
    .select("id, name, category_groups (name, type)")
    .eq("is_active", true);
  const categoryByName = new Map<string, string>();
  const allowed: string[] = [];
  for (const c of cats ?? []) {
    const g = c.category_groups as unknown as { name: string; type: string } | null;
    categoryByName.set((c.name as string).toLowerCase(), c.id as string);
    allowed.push(`${c.name} (${g?.name ?? "?"}/${g?.type ?? "?"})`);
  }
  const uncategorizedId = categoryByName.get("uncategorized") ?? null;

  // Candidates: still Uncategorized, or a mixed-basket merchant the pipeline
  // guessed at. Never anything the owner categorized by hand.
  const { data: rows } = await db
    .from("transactions")
    .select(
      "id, date, amount, merchant, merchant_clean, category_id, account_id, plaid_category_primary, plaid_category_detail, needs_review, notes"
    )
    // NULL is the common case for an uncategorized row, and `neq` never matches
    // NULL — spell out the sources we are allowed to overwrite instead.
    .or("category_source.is.null,category_source.in.(plaid,rule,merchant_map)")
    .eq("hidden", false)
    .order("date", { ascending: false })
    .limit(2000);

  const candidates = (rows ?? []).filter((t: any) => {
    // Already asked and the model said it couldn't tell — the answer won't
    // change tonight, and it's waiting on the owner in the review inbox.
    if (t.needs_review && String(t.notes ?? "").startsWith(UNSURE_PREFIX)) return false;
    const isUncat = !t.category_id || t.category_id === uncategorizedId;
    return isUncat || isMixedBasket(t.merchant_clean ?? t.merchant);
  }) as TxnLite[];

  if (!candidates.length) return { applied: 0, flagged: 0, considered: 0 };

  // History context: how the owner has categorized each merchant before.
  const { data: mapRows } = await db
    .from("merchant_map")
    .select("raw_pattern, clean_name, default_category_id");
  const catNameById = new Map((cats ?? []).map((c: any) => [c.id, c.name as string]));
  const history = new Map<string, string>();
  for (const m of mapRows ?? []) {
    if (m.default_category_id) {
      history.set(m.raw_pattern as string, catNameById.get(m.default_category_id) ?? "");
    }
  }

  const work = candidates.slice(0, MAX_PER_RUN);
  let applied = 0;
  let flagged = 0;
  const anthropic = client();

  for (let i = 0; i < work.length; i += BATCH) {
    const batch = work.slice(i, i + BATCH);
    const refs = new Map<string, TxnLite>();
    const lines = batch.map((t, n) => {
      const ref = `t${n}`;
      refs.set(ref, t);
      const name = t.merchant_clean ?? t.merchant ?? "unknown";
      const prior = history.get(merchantKey(t.merchant ?? name));
      return {
        ref,
        merchant: name,
        amount: t.amount,
        date: t.date,
        plaid_baseline: [t.plaid_category_primary, t.plaid_category_detail].filter(Boolean).join(" / ") || null,
        owner_history: prior || null,
      };
    });

    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "low", format: zodOutputFormat(CategorizeOutput) },
      system: CATEGORIZE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Allowed categories:\n${allowed.join("\n")}\n\nTransactions:\n${JSON.stringify(lines)}`,
        },
      ],
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      console.error("[enrich] categorization batch rejected (refusal or schema failure)");
      continue;
    }

    for (const r of response.parsed_output.results) {
      const txn = refs.get(r.ref);
      if (!txn) continue; // hallucinated ref
      const categoryId = categoryByName.get(r.category.trim().toLowerCase());
      if (!categoryId) {
        console.error(`[enrich] unknown category "${r.category}" — skipped`);
        continue;
      }
      const confidence = Math.max(0, Math.min(1, r.confidence));

      if (confidence >= AUTO_APPLY) {
        await db
          .from("transactions")
          .update({ category_id: categoryId, category_source: "llm", needs_review: false })
          .eq("id", txn.id);
        applied++;

        const name = txn.merchant_clean ?? txn.merchant;
        if (confidence >= TEACH_MAP && !isMixedBasket(name) && txn.merchant) {
          // Single-purpose merchant, confidently resolved: teach the map so the
          // deterministic pipeline gets it for free next time.
          await db.from("merchant_map").upsert(
            {
              raw_pattern: merchantKey(txn.merchant),
              clean_name: name,
              default_category_id: categoryId,
              confidence,
              source: "llm",
            },
            { onConflict: "raw_pattern" }
          );
        }
      } else {
        await db
          .from("transactions")
          .update({ needs_review: true, notes: ` ` })
          .eq("id", txn.id);
        flagged++;
      }
    }
  }

  await audit(db, "agent", "enrich_categorize", "transactions", undefined, {
    run_id: runId,
    considered: work.length,
    applied,
    flagged,
    model: MODEL,
  });

  return { applied, flagged, considered: work.length };
}

/**
 * Score personal-account transactions for business likelihood and file
 * suggestions. Dismissed merchants are never re-suggested.
 */
async function suggestBusiness(
  db: SupabaseClient,
  runId: string
): Promise<{ suggested: number; considered: number }> {
  const ninetyDays = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const [{ data: accounts }, { data: existing }, { data: confirmed }] = await Promise.all([
    db.from("accounts").select("id, name, is_business"),
    db.from("business_suggestions").select("transaction_id, status"),
    db
      .from("transactions")
      .select("merchant_clean, merchant")
      .eq("is_business", true)
      .limit(200),
  ]);

  const personalAccounts = new Set(
    (accounts ?? []).filter((a: any) => !a.is_business).map((a: any) => a.id as string)
  );
  if (!personalAccounts.size) return { suggested: 0, considered: 0 };

  const alreadySuggested = new Set((existing ?? []).map((s: any) => s.transaction_id as string));

  // A dismissed merchant is a decision; don't re-litigate it every night.
  const dismissedIds = (existing ?? [])
    .filter((s: any) => s.status === "dismissed")
    .map((s: any) => s.transaction_id as string);
  const dismissedMerchants = new Set<string>();
  if (dismissedIds.length) {
    const { data: dRows } = await db
      .from("transactions")
      .select("merchant, merchant_clean")
      .in("id", dismissedIds);
    for (const d of dRows ?? []) {
      const n = (d.merchant_clean ?? d.merchant) as string | null;
      if (n) dismissedMerchants.add(n.toLowerCase());
    }
  }

  const { data: rows } = await db
    .from("transactions")
    .select("id, date, amount, merchant, merchant_clean, account_id, categories (name)")
    .gte("date", ninetyDays)
    .eq("is_business", false)
    .eq("hidden", false)
    .gt("amount", 0)
    .order("date", { ascending: false })
    .limit(1000);

  const candidates = (rows ?? []).filter((t: any) => {
    if (!personalAccounts.has(t.account_id)) return false;
    if (alreadySuggested.has(t.id)) return false;
    const name = (t.merchant_clean ?? t.merchant ?? "").toLowerCase();
    return !!name && !dismissedMerchants.has(name);
  });

  if (!candidates.length) return { suggested: 0, considered: 0 };

  const confirmedNames = [
    ...new Set((confirmed ?? []).map((c: any) => (c.merchant_clean ?? c.merchant) as string).filter(Boolean)),
  ].slice(0, 40);

  const work = candidates.slice(0, MAX_PER_RUN);
  let suggested = 0;
  const anthropic = client();

  for (let i = 0; i < work.length; i += BATCH) {
    const batch = work.slice(i, i + BATCH);
    const refs = new Map<string, any>();
    const lines = batch.map((t: any, n: number) => {
      const ref = `t${n}`;
      refs.set(ref, t);
      return {
        ref,
        merchant: t.merchant_clean ?? t.merchant,
        amount: t.amount,
        date: t.date,
        category: (t.categories as unknown as { name: string } | null)?.name ?? null,
      };
    });

    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "low", format: zodOutputFormat(BusinessOutput) },
      system: BUSINESS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${
            confirmedNames.length
              ? `Merchants the owner has already confirmed as business spending:\n${confirmedNames.join(", ")}\n\n`
              : ""
          }Transactions to score:\n${JSON.stringify(lines)}`,
        },
      ],
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      console.error("[enrich] business batch rejected (refusal or schema failure)");
      continue;
    }

    for (const r of response.parsed_output.results) {
      const txn = refs.get(r.ref);
      if (!txn) continue;
      const likelihood = Math.max(0, Math.min(1, r.likelihood));
      if (likelihood < SUGGEST_BUSINESS) continue;
      const { error } = await db.from("business_suggestions").insert({
        transaction_id: txn.id,
        run_id: runId,
        confidence: likelihood,
        rationale: r.rationale,
        status: "pending",
      });
      if (!error) suggested++;
    }
  }

  await audit(db, "agent", "enrich_business", "business_suggestions", undefined, {
    run_id: runId,
    considered: work.length,
    suggested,
    model: MODEL,
  });

  return { suggested, considered: work.length };
}

/** The daily enrichment run: categorization first, then business scoring. */
export async function runEnrichment(
  db: SupabaseClient,
  trigger: "cron" | "manual" = "cron"
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[enrich] no ANTHROPIC_API_KEY — skipping");
    return;
  }

  const { data: run } = await db
    .from("agent_runs")
    .insert({ trigger: `enrich_${trigger}`, model: MODEL, status: "running" })
    .select("id")
    .single();
  if (!run) return;

  try {
    const cat = await enrichCategories(db, run.id);
    const biz = await suggestBusiness(db, run.id);
    console.log(
      `[enrich] categorized ${cat.applied}/${cat.considered} (${cat.flagged} to review), ${biz.suggested} business suggestions from ${biz.considered}`
    );
    await db
      .from("agent_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "done",
        input_snapshot: {
          categorization: cat,
          business: biz,
          thresholds: { auto_apply: AUTO_APPLY, teach_map: TEACH_MAP, suggest_business: SUGGEST_BUSINESS },
        },
      })
      .eq("id", run.id);
  } catch (e: unknown) {
    console.error("[enrich] run failed:", (e as Error).message);
    await db
      .from("agent_runs")
      .update({ finished_at: new Date().toISOString(), status: "failed", error: (e as Error).message })
      .eq("id", run.id);
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@finance/shared";
import { indexCategories, type CategoryMeta, type ReportTxn } from "@finance/shared/src/reports";
import { pace, type GoalRow } from "@finance/shared/src/goals";
import {
  computeBudget,
  computeCashFlow,
  computeCredit,
  computeGoalCosts,
  lastMonthWindow,
  lastWeekWindow,
  priorWindowFor,
  verifyGrounding,
  type Stage1Facts,
  type SubscriptionFact,
  type Window,
} from "@finance/shared/src/recap";

// Recap engine (spec §5.9). Two stages, and the separation is the point:
//
//   Stage 1 — this file's `buildFacts`, pure arithmetic over database rows.
//             Every number a recap can contain is produced here.
//   Stage 2 — Claude scores and narrates, and may only *reference* Stage 1's
//             numbers. `verifyGrounding` checks that claim against the prose;
//             an unsourced figure fails the whole run rather than shipping a
//             confident-sounding invention.

const MODEL = process.env.RECAP_MODEL ?? process.env.AGENT_MODEL ?? "claude-sonnet-5";

const ScoreSchema = z.object({
  cash_flow: z.number().describe("0-100"),
  budget_adherence: z.number().describe("0-100"),
  goal_tradeoffs: z.number().describe("0-100"),
  credit_usage: z.number().describe("0-100"),
  investing: z.number().describe("0-100"),
});

const AdjustmentSchema = z.object({
  title: z.string().describe("The concrete change, one line"),
  rationale: z.string().describe("Why, citing only numbers from the facts"),
  projected_monthly_savings: z
    .number()
    .describe("Monthly dollars saved; use 0 when the change does not save money directly"),
  confidence: z.number().describe("0 to 1"),
});

const SubscriptionVerdictSchema = z.object({
  recurring_item_id: z.string().describe("The id from the subscriptions list"),
  verdict: z.enum(["keep", "replace", "cut", "watch"]),
  reasoning: z.string(),
  suggested_alternative: z
    .string()
    .describe("A tool already paid for, a cheaper tier, or a replacement — empty string if none"),
  projected_monthly_savings: z.number().describe("0 when the verdict is keep or watch"),
});

const RecapOutput = z.object({
  scores: ScoreSchema,
  overall_score: z.number().describe("0-100, weighing the five domains"),
  narrative_md: z.string().describe("Markdown recap: what happened, what drove it, what it cost"),
  adjustments: z.array(AdjustmentSchema).describe("Zero to five concrete, actionable changes"),
  subscription_verdicts: z
    .array(SubscriptionVerdictSchema)
    .describe("One verdict per subscription in the facts; empty array for weekly recaps"),
});

const SYSTEM_PROMPT = `You write the periodic financial recap for a self-hosted personal finance platform with exactly one user, its owner.

You are given a facts object computed entirely by deterministic code. It is the only source of truth available to you.

ABSOLUTE RULE — every figure you write must already exist in the facts object.
- Never add, subtract, average, or otherwise derive a new number. If you want to say "$34/month across two subscriptions", you may not: say it about each subscription using its own figure.
- Never estimate, extrapolate, or round to a "nicer" number.
- Percentages, dollar amounts, counts and dates must all appear in the facts.
- The only numbers you may originate are your own 0-100 scores.
- A recap containing an unsourced figure is rejected outright and the run is marked failed, so when in doubt, describe the direction in words instead of inventing a figure.

Scoring: score the owner's *decisions* in this period, not their circumstances. Five domains, 0-100 each:
- cash_flow: did money in exceed money out, and did the trend improve?
- budget_adherence: did spending respect the budget lines that exist?
- goal_tradeoffs: was progress toward goals worth what it cost (interest, fees)?
- credit_usage: is utilization healthy and is carried balance being cleared?
- investing: is investable surplus being put to work? Score 50 when there is no data rather than punishing.

Tone: direct, specific, no hedging or motivational filler. The owner reads this to make a decision, not to feel good. Name the single most consequential thing first.

Adjustments must be concrete enough to act on this week, and each must be grounded in a specific fact.`;

async function loadTxns(db: SupabaseClient, w: Window): Promise<ReportTxn[]> {
  const { data } = await db
    .from("transactions")
    .select("id, date, amount, merchant, merchant_clean, category_id, account_id, is_business, business_entity, pending")
    // hidden=false counts each dollar once (a split hides its parent)
    .eq("hidden", false)
    .gte("date", w.start)
    .lte("date", w.end)
    .limit(10000);
  return (data ?? []).map((t: any) => ({ ...t, amount: Number(t.amount) }));
}

/** Stage 1: every number the recap may contain, computed by code. */
export async function buildFacts(
  db: SupabaseClient,
  periodType: "weekly" | "monthly",
  ref = new Date()
): Promise<Stage1Facts> {
  const window = periodType === "weekly" ? lastWeekWindow(ref) : lastMonthWindow(ref);
  const prior = priorWindowFor(periodType, window);

  const [{ data: catRows }, current, priorTxns] = await Promise.all([
    db.from("categories").select("id, name, emoji, group_id, category_groups (name, type)").eq("is_active", true),
    loadTxns(db, window),
    loadTxns(db, prior),
  ]);

  const cats: CategoryMeta[] = (catRows ?? []).map((c: any) => ({
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    group_id: c.group_id,
    group_name: c.category_groups?.name ?? "Ungrouped",
    group_type: c.category_groups?.type ?? "expense",
  }));
  const catIndex = indexCategories(cats);
  const catName = new Map(cats.map((c) => [c.id, c.name]));

  const cash_flow = computeCashFlow(current, priorTxns, catIndex);

  // Budget: the calendar month containing the period end, measured through the
  // period end (a weekly recap therefore reports month-to-date position).
  const monthKey = `${window.end.slice(0, 7)}-01`;
  const { data: budget } = await db
    .from("budgets")
    .select("month, budget_lines (category_id, amount, rollover_in)")
    .eq("month", monthKey)
    .maybeSingle();

  const spentByCategory = new Map<string, number>();
  if (budget) {
    const { data: monthTxns } = await db
      .from("transactions")
      .select("category_id, amount")
      .gte("date", monthKey)
      .lte("date", window.end)
      .eq("hidden", false)
      .limit(10000);
    for (const t of monthTxns ?? []) {
      const amount = Number(t.amount);
      if (!t.category_id || amount <= 0) continue;
      spentByCategory.set(t.category_id, (spentByCategory.get(t.category_id) ?? 0) + amount);
    }
  }

  const budgetFacts = computeBudget(
    budget ? monthKey : null,
    ((budget?.budget_lines ?? []) as any[]).map((l) => ({
      category_id: l.category_id,
      category_name: l.category_id ? (catName.get(l.category_id) ?? "category") : "flex bucket",
      amount: Number(l.amount),
      rollover_in: Number(l.rollover_in),
    })),
    spentByCategory
  );

  // Credit utilization + APRs
  const { data: creditAccounts } = await db
    .from("accounts")
    .select("id, mask, current_balance, available_balance, type")
    .eq("type", "credit");
  const { data: liabilityRows } = await db
    .from("liabilities")
    .select("id, account_id, apr, balance, type, accounts (mask)");
  const aprByAccount = new Map(
    (liabilityRows ?? []).map((l: any) => [l.account_id as string, l.apr != null ? Number(l.apr) : null])
  );
  const credit = computeCredit(
    (creditAccounts ?? []).map((a: any) => ({
      mask: a.mask,
      current_balance: a.current_balance,
      available_balance: a.available_balance,
      apr: aprByAccount.get(a.id) ?? null,
    }))
  );

  // Goals: contributions in-window, plus cost drivers linked to each goal
  const [{ data: goalRows }, { data: linkRows }] = await Promise.all([
    db.from("goals").select("*").eq("status", "active"),
    db.from("goal_links").select("*"),
  ]);

  // Interest actually charged in the window, per account. This is the only
  // honest source: a statement paid in full inside its grace period costs
  // nothing, and no formula over balance and APR can know that.
  const { data: interestRows } = await db
    .from("transactions")
    .select("id, account_id, amount, merchant, description, categories (name)")
    .gte("date", window.start)
    .lte("date", window.end)
    .gt("amount", 0)
    .eq("hidden", false)
    .limit(5000);
  const interestByAccount = new Map<string, { total: number; ids: string[] }>();
  for (const r of interestRows ?? []) {
    const name = (r.categories as unknown as { name: string } | null)?.name ?? "";
    const text = `${r.merchant ?? ""} ${r.description ?? ""}`;
    const isInterest =
      name === "Interest Paid" || /interest charge|interest assessed|finance charge/i.test(text);
    if (!isInterest) continue;
    const entry = interestByAccount.get(r.account_id as string) ?? { total: 0, ids: [] };
    entry.total += Number(r.amount);
    entry.ids.push(r.id as string);
    interestByAccount.set(r.account_id as string, entry);
  }

  const goals: Stage1Facts["goals"] = [];
  for (const g of (goalRows ?? []) as GoalRow[]) {
    const { data: contribs } = await db
      .from("goal_contributions")
      .select("transaction_id, amount, occurred_at")
      .eq("goal_id", g.id)
      .gte("occurred_at", `${window.start}T00:00:00Z`)
      .lte("occurred_at", `${window.end}T23:59:59Z`);

    const { data: allContribs } = await db
      .from("goal_contributions")
      .select("transaction_id, amount, occurred_at, via")
      .eq("goal_id", g.id);

    const paceResult = pace(
      g,
      (allContribs ?? []).map((c: any) => ({
        transaction_id: c.transaction_id ?? "",
        date: String(c.occurred_at).slice(0, 10),
        amount: Number(c.amount),
        merchant: "",
        via: c.via ?? "",
        entity_type: "account" as const,
        entity_id: "",
      })),
      ref
    );

    const drivers = (linkRows ?? [])
      .filter((l: any) => l.goal_id === g.id && l.role === "cost_driver" && l.entity_type === "liability")
      .map((l: any) => {
        const liab = (liabilityRows ?? []).find((x: any) => x.id === l.entity_id);
        const charges = interestByAccount.get(liab?.account_id as string) ?? {
          total: 0,
          ids: [] as string[],
        };
        return {
          liability_id: l.entity_id as string,
          account_last4: (liab?.accounts as { mask: string | null } | null)?.mask ?? null,
          balance: liab?.balance != null ? Number(liab.balance) : null,
          apr: liab?.apr != null ? Number(liab.apr) : null,
          observed_interest: charges.total,
          interest_txn_ids: charges.ids,
        };
      });

    goals.push(
      computeGoalCosts({
        goal: {
          id: g.id,
          name: g.name,
          target_amount: g.target_amount != null ? Number(g.target_amount) : null,
          current_amount: Number(g.current_amount),
          pace_status: paceResult.status,
        },
        contributions: (contribs ?? []).map((c: any) => ({
          transaction_id: c.transaction_id,
          amount: Number(c.amount),
          date: String(c.occurred_at).slice(0, 10),
        })),
        costDrivers: drivers,
        days: window.days,
      })
    );
  }

  // Net worth movement across the window
  const { data: snaps } = await db
    .from("net_worth_snapshots")
    .select("date, total")
    .gte("date", window.start)
    .lte("date", window.end)
    .order("date");
  const first = snaps?.[0];
  const last = snaps?.at(-1);
  const net_worth = {
    start: first ? Number(first.total) : null,
    end: last ? Number(last.total) : null,
    change: first && last ? Math.round((Number(last.total) - Number(first.total)) * 100) / 100 : null,
  };

  // Subscriptions — monthly recaps carry the full review set
  let subscriptions: SubscriptionFact[] = [];
  if (periodType === "monthly") {
    const { data: items } = await db
      .from("recurring_items")
      .select("id, merchant, cadence, expected_amount, status, purpose, value_notes, overlap_tags, is_subscription")
      .neq("status", "cancelled");

    const sixMonthsAgo = new Date(ref.getTime() - 190 * 86400_000).toISOString().slice(0, 10);
    for (const item of (items ?? []).filter((i: any) => i.is_subscription)) {
      const { data: charges } = await db
        .from("transactions")
        .select("date, amount")
        .ilike("merchant", `%${(item.merchant as string).slice(0, 18)}%`)
        .gte("date", sixMonthsAgo)
        .eq("hidden", false)
        .order("date", { ascending: false })
        .limit(12);

      const observed = (charges ?? []).map((c: any) => Number(c.amount));
      const expected = item.expected_amount != null ? Number(item.expected_amount) : null;
      const monthly =
        expected == null
          ? null
          : item.cadence === "annual"
            ? Math.round((expected / 12) * 100) / 100
            : item.cadence === "weekly"
              ? Math.round(expected * 4.333 * 100) / 100
              : expected;

      subscriptions.push({
        recurring_item_id: item.id as string,
        merchant: item.merchant as string,
        cadence: item.cadence,
        expected_amount: expected,
        observed_amounts: observed,
        observed_monthly_cost: monthly,
        last_charge_date: charges?.[0]?.date ?? null,
        status: item.status as string,
        purpose: item.purpose,
        value_notes: item.value_notes,
        overlap_tags: (item.overlap_tags ?? []) as string[],
      });
    }
  }

  const { data: priorRecaps } = await db
    .from("recaps")
    .select("period_start, overall_score, scores")
    .eq("period_type", periodType)
    .lt("period_start", window.start)
    .order("period_start", { ascending: false })
    .limit(2);

  return {
    period_type: periodType,
    period_start: window.start,
    period_end: window.end,
    days: window.days,
    prior_period_start: prior.start,
    prior_period_end: prior.end,
    cash_flow,
    budget: budgetFacts,
    credit,
    goals,
    net_worth,
    subscriptions,
    prior_recaps: (priorRecaps ?? []).map((r: any) => ({
      period_start: r.period_start,
      overall_score: r.overall_score != null ? Number(r.overall_score) : null,
      scores: r.scores,
    })),
  };
}

/** Persist Stage 1's cost attribution so every recap figure is re-derivable. */
async function writeGoalCosts(db: SupabaseClient, facts: Stage1Facts, runId: string) {
  for (const goal of facts.goals) {
    await db
      .from("goal_costs")
      .delete()
      .eq("goal_id", goal.goal_id)
      .eq("period_start", facts.period_start)
      .eq("period_end", facts.period_end);

    for (const cost of goal.costs) {
      const { error } = await db.from("goal_costs").insert({
        goal_id: goal.goal_id,
        period_start: facts.period_start,
        period_end: facts.period_end,
        run_id: runId,
        cost_type: cost.cost_type,
        amount: cost.amount,
        // Without this the row names the card only in prose, so the cost can
        // never be joined back to the liability it came from.
        liability_id: cost.liability_id,
        contributing_txn_ids: cost.contributing_txn_ids,
        computation: cost.computation,
        narrative: cost.narrative,
      });
      // A swallowed error here means the recap's cost attribution silently
      // vanishes while the run still reports success — which is exactly how it
      // went missing once already.
      if (error) {
        console.error(`[recap] goal_cost insert failed for ${goal.goal_name}: ${error.message}`);
      }
    }
  }
}

export async function runRecap(
  db: SupabaseClient,
  periodType: "weekly" | "monthly",
  ref = new Date()
): Promise<{ ok: boolean; reason?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[recap] no ANTHROPIC_API_KEY — skipping");
    return { ok: false, reason: "no api key" };
  }

  const facts = await buildFacts(db, periodType, ref);

  const { data: run } = await db
    .from("agent_runs")
    .insert({
      trigger: `recap_${periodType}`,
      input_snapshot: facts as unknown as Record<string, unknown>,
      model: MODEL,
      status: "running",
    })
    .select("id")
    .single();
  if (!run) return { ok: false, reason: "could not create run" };

  const fail = async (reason: string, detail?: Record<string, unknown>) => {
    await db
      .from("agent_runs")
      .update({ finished_at: new Date().toISOString(), status: "failed", error: reason })
      .eq("id", run.id);
    await audit(db, "agent", "recap_rejected", "recaps", undefined, { reason, ...detail });
    console.error(`[recap] ${periodType} rejected: ${reason}`);
    return { ok: false, reason };
  };

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(RecapOutput) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Facts for the ${periodType} recap covering ${facts.period_start} to ${facts.period_end}. Every number you use must come from this object.\n\n${JSON.stringify(facts)}`,
        },
      ],
    });

    const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return await fail(
        response.stop_reason === "refusal" ? "model refusal" : "output failed schema validation"
      );
    }

    const out = response.parsed_output;

    // The hard rule, enforced: every figure in the prose must trace to Stage 1.
    const texts = [
      out.narrative_md,
      ...out.adjustments.flatMap((a) => [a.title, a.rationale]),
      ...out.subscription_verdicts.flatMap((v) => [v.reasoning, v.suggested_alternative]),
    ];
    const numericClaims = [
      ...out.adjustments.map((a) => a.projected_monthly_savings),
      ...out.subscription_verdicts.map((v) => v.projected_monthly_savings),
    ].filter((n) => n !== 0);

    const grounding = verifyGrounding([...texts, ...numericClaims.map(String)], facts);
    if (!grounding.ok) {
      await db.from("agent_runs").update({ tokens_used: tokensUsed }).eq("id", run.id);
      return await fail(
        `unsourced figures: ${grounding.offenders.map((o) => o.value).join(", ")}`,
        { offenders: grounding.offenders, checked: grounding.checked }
      );
    }

    const scores = out.scores;
    const inRange = Object.values(scores).every((s) => s >= 0 && s <= 100);
    if (!inRange || out.overall_score < 0 || out.overall_score > 100) {
      return await fail("scores out of range");
    }

    await writeGoalCosts(db, facts, run.id);

    const { data: recap, error: recapErr } = await db
      .from("recaps")
      .upsert(
        {
          period_type: periodType,
          period_start: facts.period_start,
          period_end: facts.period_end,
          run_id: run.id,
          scores,
          overall_score: out.overall_score,
          goal_cost_summary: facts.goals,
          adjustments: out.adjustments,
          content_md: out.narrative_md,
        },
        { onConflict: "period_type,period_start" }
      )
      .select("id")
      .single();
    if (recapErr || !recap) return await fail(`could not write recap: ${recapErr?.message}`);

    if (periodType === "monthly" && out.subscription_verdicts.length) {
      // Re-running a month replaces its verdicts rather than stacking them.
      await db.from("subscription_reviews").delete().eq("recap_id", recap.id);
      const known = new Set(facts.subscriptions.map((s) => s.recurring_item_id));
      const rows = out.subscription_verdicts
        .filter((v) => known.has(v.recurring_item_id)) // never invent a subscription
        .map((v) => ({
          recap_id: recap.id,
          recurring_item_id: v.recurring_item_id,
          verdict: v.verdict,
          reasoning: v.reasoning,
          suggested_alternative: v.suggested_alternative || null,
          projected_monthly_savings: v.projected_monthly_savings,
        }));
      if (rows.length) await db.from("subscription_reviews").insert(rows);
    }

    await db
      .from("agent_runs")
      .update({ finished_at: new Date().toISOString(), tokens_used: tokensUsed, status: "done" })
      .eq("id", run.id);

    await audit(db, "agent", "recap_written", "recaps", recap.id, {
      period_type: periodType,
      period_start: facts.period_start,
      overall_score: out.overall_score,
      adjustments: out.adjustments.length,
      figures_checked: grounding.checked,
    });

    console.log(
      `[recap] ${periodType} ${facts.period_start}→${facts.period_end}: score ${out.overall_score}, ${out.adjustments.length} adjustments, ${grounding.checked} figures verified`
    );
    return { ok: true };
  } catch (e: unknown) {
    return await fail((e as Error).message);
  }
}

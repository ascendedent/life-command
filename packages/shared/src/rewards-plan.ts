/**
 * Which card each kind of spending belongs on.
 *
 * Reward rates change — categories rotate quarterly, caps reset, issuers
 * re-price — so this is computed from `card_rewards` every time rather than
 * written down. Update the rates on the Cards page and the plan follows.
 *
 * Three things decide the answer, and leaving any of them out gives advice that
 * loses money:
 *
 *   - A card that is actually revolving has no grace period. Paying each
 *     statement in full keeps it: new purchases then owe nothing until the next
 *     due date, however large the balance on screen. The grace period is lost
 *     only once a statement goes unpaid, and from then on purchases accrue from
 *     the day they post. So the test is whether the issuer has charged
 *     interest — not whether the card shows a balance. A current balance is
 *     mostly this cycle's purchases, which are not yet owed.
 *   - A capped rate is not the rate you get. A headline rate on the first
 *     N dollars a quarter blends down over a year of real spending, and the
 *     blend is what the money should follow.
 *   - A rotating category is only worth its rate while it is running. A 5% that
 *     covers one quarter earns its rate on a quarter of the spend and the card's
 *     base rate on the rest.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Whether a category can go on a card at all is measured, not assumed.
 *
 * A hand-written list of "things you cannot charge" is wrong in both
 * directions. It excludes vehicle registration, which many counties do take a
 * card for, and it allows the utility, phone and internet bills, plenty of
 * which are ACH only. The plan then confidently recommends a bonus card for
 * spending that can never reach one.
 *
 * So the test is where the money has actually been going. A category paid
 * overwhelmingly from checking earns nothing on any card, whatever rate is
 * recorded, and saying so is more useful than silently dropping it.
 */
const CHARGEABLE_THRESHOLD = 0.5;

/**
 * Spending is estimated from the median complete month, not the average.
 *
 * An average is wrecked by the events a real ledger contains: one relocation
 * turns a single moving charge into thousands a year of recurring "shipping",
 * and an insurance plan that ends on a move keeps counting for a year after
 * its last payment. The median month ignores both, and a category whose latest
 * month diverges sharply from it is flagged rather than quietly trusted.
 */
const MIN_MONTHS = 3;

export interface RewardRow {
  category: string;
  annual_spend: number;
  card: string | null;
  rate: number;
  effective_rate: number;
  annual_back: number;
  ready: boolean;
  blocked_reason: string | null;
  seasonal: boolean;
  /** The latest month is more than 50% off the median — the estimate may be stale. */
  volatile: boolean;
  note: string | null;
}

export interface RewardsPlan {
  rows: RewardRow[];
  total_optimal: number;
  total_if_flat: number;
  uplift: number;
  flat_rate: number;
  blocked_value: number;
  /** Categories paid mostly from checking — no card rate can reach them. */
  not_chargeable: { category: string; annual_spend: number; card_share: number }[];
  warnings: string[];
}

const CAP_PER_YEAR: Record<string, number> = { month: 12, quarter: 4, year: 1 };

export async function rewardsPlan(
  db: SupabaseClient,
  opts: { lookbackDays?: number; minSpend?: number } = {}
): Promise<RewardsPlan> {
  const lookback = opts.lookbackDays ?? 365;   // a year of months to take a median from
  const minSpend = opts.minSpend ?? 400;
  const since = new Date(Date.now() - lookback * 86_400_000).toISOString().slice(0, 10);

  const [{ data: accounts }, { data: rewards }, { data: liabilities }] = await Promise.all([
    db.from("accounts").select("id, name, mask, current_balance, available_balance, institutions (name)").eq("type", "credit"),
    db.from("card_rewards").select("*, categories (name)"),
    db.from("liabilities").select("account_id, is_overdue"),
  ]);

  /**
   * Cards the issuer has actually charged interest on recently.
   *
   * Interest is the one unambiguous signal that a statement went unpaid — an
   * issuer does not charge it on a card in grace. Four cycles of history keeps
   * a single old slip from condemning a card that has since been paid in full.
   */
  const revolving = new Set<string>();
  {
    const cutoff = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    const { data: charges } = await db
      .from("transactions")
      .select("account_id, amount, merchant, merchant_clean, categories (name)")
      .gte("date", cutoff).gt("amount", 0);
    const looksLikeInterest = (t: { merchant: unknown; merchant_clean: unknown; categories: unknown }) =>
      (t.categories as { name?: string } | null)?.name === "Interest Paid" ||
      /interest charge|finance charge|purchase interest/i.test(
        `${t.merchant ?? ""} ${t.merchant_clean ?? ""}`
      );
    for (const t of charges ?? []) if (looksLikeInterest(t)) revolving.add(t.account_id as string);
    for (const l of liabilities ?? []) if (l.is_overdue === true) revolving.add(l.account_id as string);
  }

  const rows: { date: string; amount: number; categories: unknown; accounts: unknown }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("transactions")
      .select("date, amount, categories (name, category_groups (type)), accounts (type)")
      .eq("hidden", false).gte("date", since)
      .order("date").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as typeof rows));
    if ((data?.length ?? 0) < 1000) break;
  }

  // Refunds are netted: a returned purchase earns no reward, and Amazon alone
  // sends back thousands a year.
  const monthly = new Map<string, Map<string, number>>();
  const where = new Map<string, { card: number; cash: number }>();
  for (const t of rows) {
    const c = t.categories as unknown as { name?: string; category_groups?: { type?: string } } | null;
    if (c?.category_groups?.type !== "expense") continue;
    const name = c.name!;
    const m = monthly.get(name) ?? new Map<string, number>();
    const key = t.date.slice(0, 7);
    m.set(key, (m.get(key) ?? 0) + Number(t.amount));
    monthly.set(name, m);
    // Where it landed decides whether a rate can ever apply to it.
    if (Number(t.amount) > 0) {
      const w = where.get(name) ?? { card: 0, cash: 0 };
      const onCard = (t.accounts as { type?: string } | null)?.type === "credit";
      if (onCard) w.card += Number(t.amount);
      else w.cash += Number(t.amount);
      where.set(name, w);
    }
  }

  // The current month is partial and would drag every median down.
  const thisMonth = new Date().toISOString().slice(0, 7);

  /**
   * Months with no spending must count as zero, not be skipped.
   *
   * A semi-annual premium appears in one month and nothing in the other five.
   * Skipping the empty ones makes the median the premium itself, as though it
   * were charged monthly.
   */
  const monthKeys: string[] = [];
  for (let d = new Date(), i = 0; i < 24; i++) {
    d = new Date(d.getFullYear(), d.getMonth() - (i === 0 ? 0 : 1), 1);
    const k = d.toISOString().slice(0, 7);
    if (k !== thisMonth && k >= since.slice(0, 7)) monthKeys.push(k);
  }
  monthKeys.sort();

  const medianOf = (name: string, keys: string[]) => {
    const m = monthly.get(name)!;
    const values = keys.map((k) => m.get(k) ?? 0).sort((a, b) => a - b);
    if (!values.length) return 0;
    const mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  };

  /**
   * Recent months win when they disagree with the year.
   *
   * Categories change regime: an insurance plan ends and its replacement lands
   * in a different category, a move generates one large shipping charge. A
   * twelve-month median keeps charging for both long after they stopped. Six
   * months tracks what is actually being spent now, and the disagreement itself
   * is worth reporting.
   */
  const RECENT = 6;
  const annual = new Map<string, number>();
  const volatile_ = new Set<string>();
  const chargeShare = new Map<string, number>();
  for (const [name, months] of monthly) {
    const present = [...months.keys()].filter((k) => k !== thisMonth);
    if (present.length < MIN_MONTHS) continue;
    const recentKeys = monthKeys.slice(-RECENT);
    const recent = medianOf(name, recentKeys);
    const full = medianOf(name, monthKeys);
    if (recent <= 0 && full <= 0) continue;
    annual.set(name, recent * 12);
    const w = where.get(name);
    if (w && w.card + w.cash > 0) chargeShare.set(name, w.card / (w.card + w.cash));
    if (Math.abs(recent - full) > Math.max(full, recent) * 0.5) volatile_.add(name);
  }

  // The issuer is part of the identity: several cards here are called only
  // "CREDIT CARD", and two different banks each have more than one of them.
  const label = new Map(
    (accounts ?? []).map((a) => {
      const bank = (a.institutions as unknown as { name?: string } | null)?.name;
      return [a.id as string, `${bank ? `${bank} — ` : ""}${a.name} ‥${a.mask ?? "????"}`];
    })
  );
  const carries = new Map((accounts ?? []).map((a) => [a.id as string, revolving.has(a.id as string)]));
  const hasRoom = new Map((accounts ?? []).map((a) => [a.id as string, Number(a.available_balance ?? 0) > 100]));
  const base = new Map<string, number>();
  for (const x of rewards ?? []) if (!x.category_id) base.set(x.account_id as string, Number(x.rate));

  // The honest comparison is against putting everything on the best flat-rate
  // card that is actually usable, not against earning nothing.
  const flatRate = Math.max(
    0,
    ...[...base].filter(([id]) => hasRoom.get(id)).map(([, r]) => r)
  );

  const today = new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];
  const out: RewardRow[] = [];
  let optimal = 0, flat = 0, blocked = 0;

  const notChargeable: { category: string; annual_spend: number; card_share: number }[] = [];
  for (const [category, spend] of [...annual].sort((a, b) => b[1] - a[1])) {
    if (spend < minSpend) continue;
    const share = chargeShare.get(category) ?? 1;
    if (share < CHARGEABLE_THRESHOLD) {
      notChargeable.push({ category, annual_spend: round(spend), card_share: round(share * 100) });
      continue;
    }

    let best: RewardRow | null = null;
    const candidates = (rewards ?? []).filter(
      (x) => (x.categories as unknown as { name?: string } | null)?.name === category
    );

    for (const x of candidates) {
      const id = x.account_id as string;
      const cardBase = base.get(id) ?? 0;
      const rate = Number(x.rate);

      // A window that does not cover the whole year only earns its rate for the
      // part it covers; the rest of the year falls back to the card's own base.
      const seasonal = !!(x.starts_on || x.ends_on);
      const activeShare = seasonal ? seasonalShare(x.starts_on as string | null, x.ends_on as string | null) : 1;
      const atRate = spend * activeShare;
      const atBase = spend - atRate;

      // A cap converts the headline rate into a blend over a year of spending.
      let capped = atRate;
      if (x.cap_amount && x.cap_period) {
        const yearlyCap = Number(x.cap_amount) * (CAP_PER_YEAR[x.cap_period as string] ?? 1) * activeShare;
        capped = Math.min(atRate, yearlyCap);
      }
      const value = (capped * rate + (atRate - capped) * cardBase + atBase * cardBase) / 100;
      const effective = spend > 0 ? (value / spend) * 100 : 0;

      const room = hasRoom.get(id) ?? false;
      const balance = carries.get(id) ?? false;
      const row: RewardRow = {
        category,
        annual_spend: round(spend),
        card: label.get(id) ?? null,
        rate,
        effective_rate: round(effective),
        annual_back: round(value),
        ready: room && !balance,
        blocked_reason: !room
          ? "no available credit"
          : balance
            ? "revolving — the issuer has charged interest, so the grace period is gone"
            : null,
        seasonal,
        volatile: volatile_.has(category),
        note: (x.note as string | null) ?? null,
      };
      // Prefer a usable card; only then the higher rate.
      if (!best) best = row;
      else if (row.ready !== best.ready) best = row.ready ? row : best;
      else if (row.effective_rate > best.effective_rate) best = row;
    }

    if (!best) {
      best = {
        category, annual_spend: round(spend), card: null, rate: flatRate,
        effective_rate: flatRate, annual_back: round((spend * flatRate) / 100),
        ready: true, blocked_reason: null, seasonal: false, volatile: volatile_.has(category),
        note: "no category rate recorded — any flat-rate card",
      };
    }
    optimal += best.annual_back;
    flat += (spend * flatRate) / 100;
    if (!best.ready) blocked += best.annual_back;
    out.push(best);
  }

  if (!flatRate) warnings.push("No base rate recorded on any card with available credit — the comparison assumes 0%.");
  const noRates = (accounts ?? []).filter((a) => !(rewards ?? []).some((x) => x.account_id === a.id));
  if (noRates.length) {
    warnings.push(
      `No rates recorded for ${noRates.length} card(s): ${noRates.map((a) => `‥${a.mask}`).join(", ")}. They are never recommended.`
    );
  }
  if (notChargeable.length) {
    warnings.push(
      `Paid mostly from checking, so no card rate applies: ${notChargeable
        .map((x) => `${x.category} (${x.card_share}% on cards)`)
        .join(", ")}. Some billers take no card at all; others charge a fee that costs more than the reward.`
    );
  }
  if (blocked > 0) {
    warnings.push(
      `${fmt(blocked)}/yr of this sits on cards the issuer has charged interest on, meaning a statement went unpaid and the grace period is gone. Purchases there accrue from the day they post. Pay those statements in full for a cycle or two to restore it. Cards showing a balance but no interest charge are fine — paying each statement in full costs nothing.`
    );
  }

  return {
    rows: out,
    total_optimal: round(optimal),
    total_if_flat: round(flat),
    uplift: round(optimal - flat),
    flat_rate: flatRate,
    blocked_value: round(blocked),
    not_chargeable: notChargeable,
    warnings,
  };
}

/** Fraction of a year a dated reward window covers. */
function seasonalShare(startsOn: string | null, endsOn: string | null): number {
  if (!startsOn && !endsOn) return 1;
  const start = startsOn ? new Date(startsOn) : new Date(Date.now());
  const end = endsOn ? new Date(endsOn) : new Date(start.getTime() + 365 * 86_400_000);
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  return Math.max(0, Math.min(1, days / 365));
}

const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => `$${n.toFixed(2)}`;

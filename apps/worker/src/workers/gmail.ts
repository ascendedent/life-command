import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  audit,
  decryptSecret,
  merchantKey,
  ITEM_CATEGORIES,
  applyReceiptItems,
  looksLikeMoneyMovement as isMoneyMovement,
} from "@finance/shared";
import {
  applyTotalLabel,
  learnTotalLabel,
  TEMPLATE_MISS_LIMIT,
} from "./receipt-templates.js";


// Gmail receipt ingestion, Path B (spec §1.7): tight-loop poll for receipt
// emails, permissive anticipation gated only on sender legitimacy, watchlist
// checks at every ingress, and receipt-driven notifications at email speed.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_QUERY =
  '(subject:receipt OR subject:"order confirmation" OR subject:"your order" OR subject:invoice OR subject:"payment confirmation") newer_than:7d';

interface GmailConnection {
  id: string;
  account_email: string | null;
  refresh_token_enc: string;
  meta: { query?: string } | null;
}

const tokenCache = new Map<string, { token: string; expires: number }>();

async function getAccessToken(
  db: SupabaseClient,
  conn: GmailConnection
): Promise<string | null> {
  const cached = tokenCache.get(conn.id);
  if (cached && Date.now() < cached.expires - 60_000) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: decryptSecret(conn.refresh_token_enc),
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    await db
      .from("connections")
      .update({ status: "error", last_error: data.error ?? `HTTP ${res.status}` })
      .eq("id", conn.id);
    return null;
  }
  tokenCache.set(conn.id, {
    token: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

export async function notify(
  db: SupabaseClient,
  title: string,
  body: string,
  opts: { priority?: "urgent" | "default"; ruleId?: string; anticipatedId?: string; txnId?: string } = {}
) {
  const topic = process.env.NTFY_TOPIC;
  let delivered = false;

  if (topic) {
    try {
      // ntfy's JSON form, not the header form. Titles here carry emoji — every
      // one of them does — and an HTTP header is a ByteString, so putting "📊"
      // in a Title header throws before the request is even sent. It was caught
      // and logged to the console, and the row below was still written saying
      // "ntfy", so the failure looked exactly like success: every notification
      // this platform has ever raised was silently dropped.
      const res = await fetch("https://ntfy.sh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          title,
          message: body,
          priority: opts.priority === "urgent" ? 5 : 3,
          tags: [opts.priority === "urgent" ? "rotating_light" : "moneybag"],
        }),
      });
      delivered = res.ok;
      if (!res.ok) {
        console.error(`[notify] ntfy rejected: HTTP ${res.status} ${await res.text()}`);
      }
    } catch (e: unknown) {
      console.error("[notify] ntfy failed:", (e as Error).message);
    }
  }

  await db.from("notifications_log").insert({
    rule_id: opts.ruleId ?? null,
    anticipated_transaction_id: opts.anticipatedId ?? null,
    transaction_id: opts.txnId ?? null,
    // What actually happened, not what was configured. Recording the intent
    // is how a broken channel stays invisible.
    channel: delivered ? "ntfy" : topic ? "ntfy_failed" : "none",
    content: `${title}: ${body}`,
  });
}

// ---------- parsing helpers ---------------------------------------------------

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function decodeBody(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  function walk(p: Record<string, unknown>) {
    const body = p.body as { data?: string } | undefined;
    const mime = p.mimeType as string | undefined;
    if (body?.data && (mime?.startsWith("text/") ?? false)) {
      parts.push(Buffer.from(body.data, "base64url").toString("utf8"));
    }
    for (const child of (p.parts as Record<string, unknown>[] | undefined) ?? []) walk(child);
  }
  walk(payload);
  return parts
    .join("\n")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // Retailers render line items as images, so the product names live only in
    // alt/title attributes. Stripping tags first threw them away: a Walmart
    // order reduced to "Order total $35.60 5 items", with nothing to
    // categorise. Surface that text before the tags go.
    .replace(/<(?:img|area)\b[^>]*?\b(?:alt|title)=["']([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 20000);
}

/**
 * Amounts that are never what you paid. Deliberately narrow: "discount" and
 * "off" are NOT here, because a real total legitimately reads "Order total —
 * includes all fees, taxes and discounts $35.60", and excluding it would throw
 * away the right answer to avoid the wrong one.
 */
const NOT_A_CHARGE =
  /(?:you\s+saved|saved\s+a\s+total|savings|cash\s?back|rewards?\b|estimated\s+\w+\s+cash|\bpoints\b|\btip\b|\bbalance\b)/i;

/** Wording that names the actual amount charged. */
const STRONG_TOTAL =
  /(?:order|grand|invoice|purchase)\s+total|total\s+(?:charged|paid|billed)|amount\s+(?:charged|paid|billed)/i;
/** Weaker hints — a bare "total", or payment wording. */
const WEAK_TOTAL = /\btotal\b|\bamount\s+due\b|\bpayment\b|\bcharged\b|\bpaid\b/i;

export interface ExtractedTotal {
  total: number | null;
  /** True when the amount sat next to explicit total wording — trust it. */
  labeled: boolean;
}

/**
 * Pick the amount actually charged.
 *
 * Ranked by how the surrounding text describes each figure, not by where it
 * sits on the page. Taking the last labelled match used to grab "You saved a
 * total of $11.80" out of an order whose real total was $35.60, because that
 * phrase contains the word "total" and appears further down.
 */
export function extractTotal(text: string): ExtractedTotal {
  let best: { value: number; score: number } | null = null;
  let prevEnd = 0;

  for (const m of text.matchAll(/\$\s?([\d,]+\.\d{2})/g)) {
    const at = m.index ?? 0;
    // Look back only as far as the previous amount: "You earned cash back
    // $5.00 Order total $74.20" must not let the first figure's wording
    // disqualify the second.
    const before = text.slice(Math.max(prevEnd, at - 80), at);
    prevEnd = at + m[0].length;
    if (NOT_A_CHARGE.test(before)) continue;

    const score = STRONG_TOTAL.test(before) ? 2 : WEAK_TOTAL.test(before) ? 1 : 0;
    const value = Number(m[1].replace(/,/g, ""));
    // Later matches win ties, so a repeated total near the end still lands.
    if (!best || score >= best.score) best = { value, score };
  }

  if (!best) return { total: null, labeled: false };
  return { total: best.value, labeled: best.score > 0 };
}

// ---------- banks are not merchants ------------------------------------------

/**
 * A bank or card issuer emailing you is sending a statement, a transaction
 * alert, a payment-due notice or a fraud warning — never a purchase receipt.
 *
 * Ingesting one creates a phantom anticipation named after the *card*, which
 * then tries to reconcile against the very transaction it was describing:
 * "Is Getoutpass the same as Capital One | Quicksilver?" The answer is neither
 * yes nor no — the question should never have been asked.
 *
 * Two signals, because neither is complete alone:
 *   - issuer domains common enough to name outright;
 *   - the institutions actually linked through Plaid, which makes this
 *     self-configuring for whichever banks a given owner uses.
 * Deliberately excluded: PayPal, Apple, Google, Amazon — payment processors
 * and marketplaces that do send genuine receipts.
 */
const ISSUER_DOMAIN_HINTS = [
  "capitalone", "chase", "discover", "americanexpress", "amex", "citi",
  "citibank", "wellsfargo", "bankofamerica", "bofa", "usbank", "synchrony",
  "barclay", "onepay", "sofi", "ally", "navyfederal", "schwab", "fidelity",
  "vanguard", "creditkarma", "experian", "equifax", "transunion", "creditone",
  "firstpremier", "mercury", "brex", "ramp", "creditunion", "fcu", "bank",
];

/** Statement/alert phrasing that a purchase receipt would not use. */
const STATEMENT_SUBJECT_HINTS = [
  "statement", "minimum payment", "payment due", "autopay", "balance alert",
  "transaction alert", "your account", "credit score", "available credit",
  "payment received", "payment posted", "card ending",
];

/**
 * Money moving is not money spent.
 *
 * Transfers, deposits, payroll and retirement contributions all arrive as
 * confirmations carrying a real dollar amount, so nothing upstream flags them —
 * but none of them is an expense, and a "vendor" like
 * "Online Transfer to CHK ...4321 transaction#: 10293847561" is a bank
 * descriptor rather than a merchant. Matched against the parsed vendor and the
 * subject, since either may carry the giveaway.
 */
export function looksLikeMoneyMovement(vendor: string | null, subject: string): boolean {
  return isMoneyMovement(`${vendor ?? ""} ${subject}`);
}

/**
 * A price quoted in a notice is not a price you were charged.
 *
 * "Your subscription is expiring — eero Plus $99.99/year" extracts cleanly and
 * describes a charge that has not happened and may never happen. Kept tight on
 * purpose: the model is the general-purpose judge, and over-broad patterns here
 * would silently drop real receipts, which is the more expensive mistake.
 */
const FUTURE_NOTICE_PATTERNS = [
  /\b(?:is|are|will be)\s+expiring\b/i,
  /\bexpir(?:es|ing)\s+(?:on|soon|in)\b/i,
  /\bwill\s+(?:expire|renew|be charged|be billed)\b/i,
  /\brenews?\s+(?:on|automatically)\b/i,
  /\bauto-?renew/i,
  /\bupcoming\s+(?:charge|payment|renewal|bill|invoice)\b/i,
  /\bscheduled\s+(?:for|to)\s+(?:renew|charge|bill)/i,
  /\bpayment\s+reminder\b/i,
  /\byour\s+(?:free\s+)?trial\b/i,
  /\bprice\s+(?:change|increase)\b/i,
  /\bupdate\s+your\s+payment\b/i,
];

export function looksLikeFutureNotice(vendor: string | null, subject: string): boolean {
  const hay = `${vendor ?? ""} ${subject}`;
  return FUTURE_NOTICE_PATTERNS.some((re) => re.test(hay));
}

/**
 * Money coming back is not money spent.
 *
 * "You're getting a $19.40 refund" is a well-formed receipt in every respect —
 * verified sender, real merchant, labelled total, itemised — and ingesting it
 * anticipates a charge that will never post while attaching a refund's paperwork
 * to the purchase it reverses. Return-pickup and cancellation mail is the same
 * story told earlier.
 */
const REFUND_PATTERNS = [
  /\brefund(?:ed|ing)?\b/i,
  /\breturn(?:ed)?\s+(?:is|was|has been|received|initiated|accepted|processed)\b/i,
  /\byour\s+return\b/i,
  /\bpick\s?up\s+your\s+return\b/i,
  /\border\s+(?:was\s+)?cancell?ed\b/i,
  /\bcancell?ation\s+confirm/i,
  /\bmoney\s+back\b/i,
  /\bcredit(?:ed)?\s+to\s+your\s+(?:account|card)\b/i,
];

export function looksLikeRefund(vendor: string | null, subject: string): boolean {
  const hay = `${vendor ?? ""} ${subject}`;
  return REFUND_PATTERNS.some((re) => re.test(hay));
}

export function looksFinancialSender(opts: {
  from: string;
  senderDomain: string | null;
  vendor: string | null;
  subject: string;
  institutionNames: string[];
}): boolean {
  const domain = (opts.senderDomain ?? "").toLowerCase();
  const from = opts.from.toLowerCase();
  const vendor = (opts.vendor ?? "").toLowerCase();
  const subject = opts.subject.toLowerCase();

  if (ISSUER_DOMAIN_HINTS.some((h) => domain.includes(h))) return true;

  // A linked institution's name showing up as the "merchant" is the giveaway:
  // "Capital One | Quicksilver", "OnePay CashRewards Card".
  for (const name of opts.institutionNames) {
    const n = name.toLowerCase().trim();
    if (n.length < 4) continue;
    if (vendor.includes(n) || from.includes(n)) return true;
  }

  // Issuer language in the subject, but only from an unrecognised merchant —
  // a real receipt saying "payment received" still has a merchant vendor.
  if (!vendor && STATEMENT_SUBJECT_HINTS.some((h) => subject.includes(h))) return true;

  return false;
}

async function loadInstitutionNames(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("institutions").select("name");
  return (data ?? []).map((i: { name: string }) => i.name).filter(Boolean);
}

export interface SenderRule {
  match_type: "domain" | "address" | "vendor";
  pattern: string;
  action: "ignore" | "allow";
}

export async function loadSenderRules(db: SupabaseClient): Promise<SenderRule[]> {
  const { data } = await db
    .from("receipt_sender_rules")
    .select("match_type, pattern, action");
  return (data ?? []) as SenderRule[];
}

/**
 * The owner's explicit verdict on a sender, which outranks every heuristic.
 * Returns "ignore", "allow", or null when no rule applies.
 *
 * Domain matching is suffix-aware so a rule on "capitalone.com" also covers
 * "notification.capitalone.com" — nobody should have to enumerate subdomains.
 */
export function senderRuleVerdict(
  rules: SenderRule[],
  opts: { from: string; senderDomain: string | null; vendor: string | null }
): "ignore" | "allow" | null {
  const from = opts.from.toLowerCase();
  const domain = (opts.senderDomain ?? "").toLowerCase();
  const vendor = (opts.vendor ?? "").toLowerCase();

  const matches = (r: SenderRule) => {
    const p = r.pattern.toLowerCase().trim();
    if (!p) return false;
    if (r.match_type === "domain") return domain === p || domain.endsWith(`.${p}`);
    if (r.match_type === "address") return from.includes(p);
    return vendor.includes(p);
  };

  // An explicit allow beats an ignore, so rescuing one sender from a broad
  // domain rule does not require deleting the domain rule.
  if (rules.some((r) => r.action === "allow" && matches(r))) return "allow";
  if (rules.some((r) => r.action === "ignore" && matches(r))) return "ignore";
  return null;
}

// ---------- LLM fallback parse (spec §1.7: optional LLM parse) ----------------

const ReceiptItemSchema = z.object({
  description: z.string().describe("The product name as printed on the receipt"),
  amount: z
    .number()
    .nullable()
    .describe("Line total for this item in dollars, null if the email names the item but never prices it. Do not guess or divide the order total."),
  qty: z.number().nullable().describe("Quantity if stated, else null"),
  category: z
    .enum(ITEM_CATEGORIES)
    .nullable()
    .describe("What kind of thing this is. groceries = food and drink to prepare at home, including produce, dairy, snacks and non-alcoholic beverages. household = cleaning, paper goods, kitchen and home supplies. personal_care = toiletries, cosmetics, hygiene. pharmacy = medicine, vitamins, first aid. baby_kids = toys, baby gear, children's items. Use null only when the description is too vague to place."),
});

const ReceiptParseSchema = z.object({
  is_purchase_receipt: z
    .boolean()
    .describe("True ONLY for an actual purchase/order/payment confirmation from the merchant that sold something. False for anything sent by a bank or card issuer — statements, transaction alerts, payment-due or payment-received notices, balance and fraud alerts — and for shipping updates, newsletters, and mail previews. A credit card company telling you about a charge is not a receipt for that charge. A refund or return confirmation is money coming back, not a purchase — also false."),
  document_type: z
    .enum(["purchase", "refund", "shipping", "order_update", "statement", "notice", "other"])
    .describe("What this email actually is. 'purchase' only when the merchant is confirming money was charged. 'refund' for refund/return confirmations. 'order_update' for substitutions, cancellations and adjusted-total notices, which quote amounts that were never charged."),
  vendor: z.string().describe("The merchant name, cleanly formatted"),
  total: z.number().nullable().describe("The final amount charged, null if none stated"),
  subtotal: z.number().nullable().describe("Pre-tax subtotal if stated, else null"),
  tax: z.number().nullable().describe("Tax if stated, else null"),
  item_count: z
    .number()
    .nullable()
    .describe("How many items the email says the order contains (e.g. '21 items'), even when it lists fewer. Null if unstated."),
  line_items: z
    .array(ReceiptItemSchema)
    .describe("Items actually purchased in THIS order. Include an item even if it has no price. Never include products from marketing sections — 'Recently viewed items', 'Trending in store', 'Explore more savings', 'Recommended for you', 'Sponsored', 'You might also like' — those were not bought. Empty array if the email lists no items."),
  card_last4: z.string().nullable().describe("Last 4 digits of the payment card if mentioned"),
});

export async function llmParseReceipt(
  subject: string,
  from: string,
  body: string
): Promise<z.infer<typeof ReceiptParseSchema> | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: process.env.RECEIPT_MODEL ?? "claude-sonnet-5",
      max_tokens: 4000,
      output_config: {
        effort: "low",
        format: zodOutputFormat(ReceiptParseSchema),
      },
      messages: [
        {
          role: "user",
          content: `Classify and parse this email.\nFrom: ${from}\nSubject: ${subject}\n\nBody (text-stripped):\n${body.slice(0, 8000)}`,
        },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) return null;
    return response.parsed_output;
  } catch (e: unknown) {
    console.error("[gmail] llm parse failed:", (e as Error).message);
    return null;
  }
}

function extractLast4(text: string): string | null {
  const m =
    text.match(/(?:ending(?:\s+in)?|card ending|last 4(?: digits)?)[^\d]{0,12}(\d{4})\b/i) ??
    text.match(/[x*•]{2,}\s?(\d{4})\b/);
  return m?.[1] ?? null;
}

// ---------- watchlist ---------------------------------------------------------

export async function checkWatchlist(
  db: SupabaseClient,
  vendorText: string,
  ingress: "email_receipt" | "anticipation" | "plaid_sync" | "recurring_detect",
  refs: { anticipatedId?: string; txnId?: string; emailReceiptId?: string; amount?: number | null }
): Promise<void> {
  const { data: flags } = await db
    .from("vendor_watchlist")
    .select("id, vendor_name, flag_type, reason, cancelled_on, vendor_signatures (descriptor_patterns, name_aliases)")
    .eq("is_active", true);
  if (!flags?.length) return;

  const key = merchantKey(vendorText);
  for (const flag of flags) {
    const sig = flag.vendor_signatures as unknown as {
      descriptor_patterns: string[];
      name_aliases: string[];
    } | null;
    const names = [flag.vendor_name, ...(sig?.name_aliases ?? []), ...(sig?.descriptor_patterns ?? [])];
    const hit = names.some(
      (n) => n && (key.includes(merchantKey(n)) || merchantKey(n).includes(key))
    );
    if (!hit) continue;

    // auto-file the dispute/refund queue item
    const { data: rec } = await db
      .from("recommendations")
      .insert({
        type: "alert",
        summary: `RED FLAG: charge matching watchlisted vendor "${flag.vendor_name}" (${flag.flag_type})`,
        rationale: `Watchlist reason: ${flag.reason ?? "none recorded"}${flag.cancelled_on ? `; cancelled on ${flag.cancelled_on}` : ""}. Detected at ${ingress} with vendor text "${vendorText}"${refs.amount ? `, amount $${refs.amount}` : ""}. ${flag.flag_type === "cancelled" ? "No further charges are valid — dispute or request a refund." : "Vendor was flagged as fraud — dispute immediately."}`,
        payload: null,
        confidence: 0.95,
        status: "pending",
        expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      })
      .select("id")
      .single();

    await db.from("watchlist_hits").insert({
      watchlist_id: flag.id,
      ingress,
      anticipated_transaction_id: refs.anticipatedId ?? null,
      transaction_id: refs.txnId ?? null,
      email_receipt_id: refs.emailReceiptId ?? null,
      amount: refs.amount ?? null,
      alerted_at: new Date().toISOString(),
      recommendation_id: rec?.id ?? null,
    });

    await notify(
      db,
      `🚨 Watchlist hit: ${flag.vendor_name}`,
      `${flag.flag_type === "fraud" ? "Fraud-flagged" : "Cancelled"} vendor charged${refs.amount ? ` $${refs.amount}` : ""} — via ${ingress}. Reason: ${flag.reason ?? "n/a"}`,
      { priority: "urgent", anticipatedId: refs.anticipatedId, txnId: refs.txnId }
    );
    await audit(db, "system", "watchlist_hit", "vendor_watchlist", flag.id, {
      ingress,
      vendor: vendorText,
    });
  }
}

// ---------- anticipation ------------------------------------------------------

async function createAnticipation(
  db: SupabaseClient,
  receipt: {
    id: string;
    vendor: string;
    total: number;
    card_last4: string | null;
    sender_verified: boolean;
  }
): Promise<void> {
  // sender legitimacy is the only hard gate (spec §1.7.1)
  if (!receipt.sender_verified) {
    await db
      .from("anticipated_transactions")
      .insert({
        email_receipt_id: receipt.id,
        vendor: receipt.vendor,
        amount: receipt.total,
        card_last4: receipt.card_last4,
        verification_state: "unverified_vendor",
        status: "quarantined",
        expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
      });
    return;
  }

  const key = merchantKey(receipt.vendor);
  const [{ data: signature }, { data: mapped }] = await Promise.all([
    db
      .from("vendor_signatures")
      .select("id, descriptor_patterns")
      .ilike("vendor_name", `%${receipt.vendor}%`)
      .maybeSingle(),
    key
      ? db.from("merchant_map").select("default_category_id").eq("raw_pattern", key).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // card attribution via last-four (spec §1.7.3)
  let accountId: string | null = null;
  let isBusiness = false;
  let businessEntity: string | null = null;
  if (receipt.card_last4) {
    const { data: account } = await db
      .from("accounts")
      .select("id, is_business, business_entity")
      .eq("mask", receipt.card_last4)
      .maybeSingle();
    if (account) {
      accountId = account.id;
      isBusiness = account.is_business;
      businessEntity = account.business_entity;
    }
  }

  const { data: ant } = await db
    .from("anticipated_transactions")
    .insert({
      email_receipt_id: receipt.id,
      vendor: receipt.vendor,
      amount: receipt.total,
      expected_descriptor_patterns: signature?.descriptor_patterns ?? [],
      card_last4: receipt.card_last4,
      account_id: accountId,
      category_id: (mapped as { default_category_id: string | null } | null)?.default_category_id ?? null,
      is_business: isBusiness,
      business_entity: businessEntity,
      verification_state: signature ? "known_vendor" : "unverified_vendor",
      status: "open",
      expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
    })
    .select("id")
    .single();

  await checkWatchlist(db, receipt.vendor, "anticipation", {
    anticipatedId: ant?.id,
    amount: receipt.total,
  });

  // receipt-driven spend notifications at email speed (spec §1.7.7)
  const { data: rules } = await db
    .from("notification_rules")
    .select("id, type, min_amount, vendor_pattern, account_id")
    .eq("is_active", true);
  for (const rule of rules ?? []) {
    const amountHit =
      rule.type === "spend_threshold" &&
      rule.min_amount != null &&
      receipt.total >= Number(rule.min_amount);
    const vendorHit =
      rule.type === "vendor_match" &&
      rule.vendor_pattern &&
      key.includes(merchantKey(rule.vendor_pattern));
    const accountOk = !rule.account_id || rule.account_id === accountId;
    if ((amountHit || vendorHit) && accountOk) {
      await notify(
        db,
        `💳 ${receipt.vendor}: $${receipt.total.toFixed(2)}`,
        `Receipt just arrived${receipt.card_last4 ? ` — card …${receipt.card_last4}` : ""}. Bank posting expected within days.`,
        { ruleId: rule.id, anticipatedId: ant?.id }
      );
    }
  }
}

// ---------- late-receipt matching against existing transactions ---------------

async function matchAgainstExisting(
  db: SupabaseClient,
  receiptId: string,
  vendor: string,
  total: number
): Promise<boolean> {
  const windowStart = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
  const { data: candidates } = await db
    .from("transactions")
    .select("id, merchant, merchant_clean, amount, date")
    .gte("date", windowStart)
    .gt("amount", 0)
    .is("parent_transaction_id", null);

  const key = merchantKey(vendor);
  const exact = (candidates ?? []).filter((t) => {
    const amountOk = Math.abs(Number(t.amount) - total) < 0.005;
    const nameOk =
      key &&
      (merchantKey(t.merchant).includes(key) || key.includes(merchantKey(t.merchant)));
    return amountOk && nameOk;
  });

  if (exact.length === 1) {
    const txn = exact[0];
    await db.from("receipts").insert({
      transaction_id: txn.id,
      file_ref: `email:${receiptId}`,
      source: "gmail",
    });
    await db
      .from("transactions")
      .update({ receipt_status: "uploaded" })
      .eq("id", txn.id);
    await db
      .from("email_receipts")
      .update({
        match_status: "auto_matched",
        matched_transaction_id: txn.id,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", receiptId);
    // The receipt knows what was in the basket; the bank only knows the total.
    await applyReceiptItems(db, receiptId, txn.id).catch((e: Error) =>
      console.error("[gmail] item split failed:", e.message)
    );
    return true;
  }

  const near = (candidates ?? []).filter((t) => {
    const amt = Number(t.amount);
    const within2 = Math.abs(amt - total) / total < 0.02;
    const tipRange = amt > total * 1.1 && amt < total * 1.25;
    return within2 || tipRange;
  });
  if (near.length > 0 || exact.length > 1) {
    await db.from("email_receipts").update({ match_status: "ambiguous" }).eq("id", receiptId);
  }
  return false;
}

// ---------- the poll loop -----------------------------------------------------

export async function pollGmail(db: SupabaseClient): Promise<void> {
  const { data: connections } = await db
    .from("connections")
    .select("id, account_email, refresh_token_enc, meta")
    .eq("provider", "gmail");
  const conns = (connections ?? []) as GmailConnection[];
  for (const conn of conns) {
    try {
      await pollMailbox(db, conn);
    } catch (e: unknown) {
      console.error(`[gmail] ${conn.account_email} poll failed:`, (e as Error).message);
    }
  }
  await backfillUnparsed(db, conns);
}

/** Gradually re-parse verified receipts that regex couldn't extract a total
 *  from before the LLM fallback existed (a few per cycle). */
async function backfillUnparsed(db: SupabaseClient, conns: GmailConnection[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY || !conns.length) return;
  const { data: rows } = await db
    .from("email_receipts")
    .select("id, external_id, mailbox, vendor, sender_verified")
    .is("total", null)
    .is("line_items", null)
    .eq("sender_verified", true)
    .eq("match_status", "unmatched")
    .limit(5);
  if (!rows?.length) return;

  const byMailbox = new Map(conns.map((c) => [c.account_email, c]));
  for (const row of rows) {
    const conn = byMailbox.get(row.mailbox);
    if (!conn) continue;
    try {
      const token = await getAccessToken(db, conn);
      if (!token) continue;
      const msg = await fetch(`${GMAIL}/messages/${row.external_id}?format=full`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      const headers = msg.payload?.headers ?? [];
      const result = await llmParseReceipt(
        header(headers, "Subject"),
        header(headers, "From"),
        decodeBody(msg.payload ?? {})
      );
      if (!result) {
        // mark attempted so we don't loop on it forever
        await db.from("email_receipts").update({ line_items: { llm: null } }).eq("id", row.id);
        continue;
      }
      const patch: Record<string, unknown> = {
        line_items: { llm: result },
        vendor: result.vendor || row.vendor,
        match_status: result.is_purchase_receipt ? "unmatched" : "ignored",
      };
      if (result.total != null) patch.total = result.total;
      if (result.card_last4) patch.card_last4 = result.card_last4;
      await db.from("email_receipts").update(patch).eq("id", row.id);

      if (result.is_purchase_receipt && result.total != null && result.total > 0) {
        const matched = await matchAgainstExisting(db, row.id, result.vendor, result.total);
        if (!matched) {
          await createAnticipation(db, {
            id: row.id,
            vendor: result.vendor,
            total: result.total,
            card_last4: result.card_last4,
            sender_verified: true,
          });
        }
      }
    } catch (e: unknown) {
      console.error(`[gmail] backfill ${row.id} failed:`, (e as Error).message);
    }
  }
  console.log(`[gmail] backfill parsed ${rows.length} receipt(s)`);
}

async function pollMailbox(db: SupabaseClient, conn: GmailConnection): Promise<void> {
  // Linked-bank names make issuer detection self-configuring per install.
  const institutionNames = await loadInstitutionNames(db);
  const senderRules = await loadSenderRules(db);

  const { data: templateRows } = await db
    .from("vendor_receipt_templates")
    .select("vendor_key, total_label, hits, misses, status")
    .neq("status", "disabled");
  const templates = new Map<string, { total_label: string | null; hits: number; misses: number }>(
    (templateRows ?? []).map((t: any) => [
      t.vendor_key,
      { total_label: t.total_label, hits: t.hits ?? 0, misses: t.misses ?? 0 },
    ])
  );
  const token = await getAccessToken(db, conn);
  if (!token) return;

  // per-mailbox query (Account page) > env override > built-in default;
  // a recency guard is appended unless the query already has one
  let query = conn.meta?.query?.trim() || process.env.GMAIL_RECEIPT_QUERY || DEFAULT_QUERY;
  if (!/newer_than:|after:/.test(query)) query = `(${query}) newer_than:7d`;
  const listRes = await fetch(
    `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=25`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) {
    console.error(`[gmail] list failed: HTTP ${listRes.status}`);
    return;
  }
  const list = await listRes.json();
  const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
  if (!ids.length) {
    await db.from("connections").update({ last_polled_at: new Date().toISOString() }).eq("id", conn.id);
    return;
  }

  const { data: existing } = await db
    .from("email_receipts")
    .select("external_id")
    .in("external_id", ids);
  const seen = new Set((existing ?? []).map((e) => e.external_id));
  const fresh = ids.filter((id) => !seen.has(id));

  for (const id of fresh) {
    try {
      const msg = await fetch(`${GMAIL}/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());

      const headers = msg.payload?.headers ?? [];
      const from = header(headers, "From");
      const authResults = header(headers, "Authentication-Results");
      const senderVerified =
        /dkim=pass/i.test(authResults) && /spf=pass/i.test(authResults);
      const domainMatch = from.match(/@([a-z0-9.-]+)/i);
      const senderDomain = domainMatch?.[1]?.toLowerCase() ?? null;
      const vendor =
        from.replace(/<[^>]*>/, "").replace(/["']/g, "").trim() ||
        senderDomain?.split(".")[0] ||
        "Unknown";

      const body = decodeBody(msg.payload ?? {});
      const subject = header(headers, "Subject");
      const extracted = extractTotal(`${subject} ${body}`);
      let total = extracted.total;
      let last4 = extractLast4(body);
      let parsedVendor: string | null = null;
      let llmResult: Awaited<ReturnType<typeof llmParseReceipt>> = null;
      const receivedAt = new Date(Number(msg.internalDate)).toISOString();

      // A layout learned from this vendor's first receipt outranks every
      // heuristic: it is what this vendor actually calls the amount charged.
      const templateKey = merchantKey(senderDomain ?? vendor);
      const template = templates.get(templateKey) ?? null;
      let templateHit = false;
      if (template?.total_label) {
        const fromTemplate = applyTotalLabel(body, template.total_label);
        if (fromTemplate != null) {
          total = fromTemplate;
          templateHit = true;
        }
      }

      // regex came up empty on a verified sender → let the model read it
      // Classification is not optional, and must not be skipped just because
      // the regex found a number. "Your subscription is expiring — $99.99/year"
      // parses perfectly and is not a purchase; under the old order (only ask
      // the model when extraction failed) that notice became a phantom charge.
      // Extraction still prefers the regex; the model decides what it *is*.
      //
      // Unless a deterministic rule has already decided. Issuer mail, transfer
      // confirmations, refund notices and the owner's own sender rules are
      // settled without a model, and they are the mail that arrives most often —
      // asking anyway spends a call per message to be told what we knew.
      const earlyVerdict = senderRuleVerdict(senderRules, { from, senderDomain, vendor });
      const earlyIgnore =
        earlyVerdict === "ignore"
          ? "sender rule"
          : earlyVerdict === "allow"
            ? null
            : looksFinancialSender({ from, senderDomain, vendor, subject, institutionNames })
              ? "bank or card issuer"
              : looksLikeMoneyMovement(vendor, subject)
                ? "money movement, not a purchase"
                : looksLikeRefund(vendor, subject)
                  ? "refund or return, not a purchase"
                  : looksLikeFutureNotice(vendor, subject)
                    ? "notice about a future charge"
                    : null;

      if (senderVerified && !earlyIgnore) {
        llmResult = await llmParseReceipt(subject, from, body);
        if (llmResult) {
          // Precedence: learned template > labelled total > the model >
          // an unlabelled guess. The guess is what picks up reward balances
          // and shipping costs, so it loses to an actual reading of the page.
          if (!templateHit) {
            if (!extracted.labeled && llmResult.total != null) total = llmResult.total;
            else if (total == null) total = llmResult.total;
          }
          last4 = last4 ?? llmResult.card_last4;
          parsedVendor = llmResult.vendor || null;
        }
      }

      // cross-mailbox duplicate guard: the same receipt CC'd to two linked
      // inboxes arrives with different message ids — don't double-anticipate.
      //
      // The duplicate is still recorded. Skipping the insert left the message
      // absent from email_receipts, so the next poll found it "fresh" again and
      // re-read it through the model — a loop that ran every 45 seconds and
      // never terminated, because the only thing that ends it is the row it
      // wasn't writing.
      let duplicateOf: string | null = null;
      if (total != null) {
        const { data: dupe } = await db
          .from("email_receipts")
          .select("id")
          .eq("vendor", vendor)
          .eq("total", total)
          .gte("received_at", new Date(Date.parse(receivedAt) - 6 * 3600_000).toISOString())
          .lte("received_at", new Date(Date.parse(receivedAt) + 6 * 3600_000).toISOString())
          .limit(1);
        duplicateOf = dupe?.[0]?.id ?? null;
      }

      const finalVendor = parsedVendor ?? vendor;

      // Why this might not be a purchase, in precedence order. The owner's own
      // rule outranks every heuristic; the deterministic checks outrank the
      // model, because a false positive here invents a purchase that never
      // happened and then asks you to reconcile it.
      //
      // The early checks ran on the From-derived vendor; they run again on the
      // vendor the model cleaned up, which is often the first time the real
      // merchant name is legible.
      const verdict = senderRuleVerdict(senderRules, { from, senderDomain, vendor: finalVendor });
      let ignoreReason: string | null = earlyIgnore;
      if (ignoreReason) {
        // already settled without a model
      } else if (duplicateOf) {
        ignoreReason = "duplicate of a receipt already ingested";
      } else if (verdict === "ignore") {
        ignoreReason = "sender rule";
      } else if (verdict !== "allow") {
        if (looksFinancialSender({ from, senderDomain, vendor: finalVendor, subject, institutionNames })) {
          ignoreReason = "bank or card issuer";
        } else if (looksLikeMoneyMovement(finalVendor, subject)) {
          ignoreReason = "money movement, not a purchase";
        } else if (looksLikeRefund(finalVendor, subject)) {
          ignoreReason = "refund or return, not a purchase";
        } else if (looksLikeFutureNotice(finalVendor, subject)) {
          ignoreReason = "notice about a future charge";
        } else if (
          llmResult != null &&
          (!llmResult.is_purchase_receipt || llmResult.document_type !== "purchase")
        ) {
          // Either signal is enough. Missing a real receipt costs a manual
          // match; inventing one puts a charge in the books that never happened.
          ignoreReason = `not a purchase receipt (${llmResult.document_type})`;
        }
      }

      const isNoise = ignoreReason != null;

      // Learn this vendor's layout from the model's answer — once. The label
      // is derived mechanically from where the confirmed total sits in the
      // text, so no second model call is needed and the rule is inspectable.
      if (!isNoise && llmResult?.is_purchase_receipt && total != null) {
        if (templateHit) {
          await db
            .from("vendor_receipt_templates")
            .update({ hits: (template!.hits ?? 0) + 1, status: "learned", misses: 0 })
            .eq("vendor_key", templateKey);
        } else if (!template) {
          const label = learnTotalLabel(body, total);
          if (label) {
            await db.from("vendor_receipt_templates").upsert(
              {
                vendor_key: templateKey,
                vendor_name: parsedVendor ?? vendor,
                sender_domain: senderDomain,
                total_label: label,
                learned_from: id,
                learned_total: total,
                confidence: extracted.labeled ? 0.9 : 0.75,
                status: "learned",
              },
              { onConflict: "vendor_key" }
            );
            templates.set(templateKey, { total_label: label, hits: 0, misses: 0 });
            console.log(`[gmail] learned layout for ${parsedVendor ?? vendor}: "${label}" → ${total}`);
          }
        } else {
          // Template exists but did not match this email: the vendor changed
          // their layout. Count the miss and relearn once it is consistent.
          const misses = (template.misses ?? 0) + 1;
          await db
            .from("vendor_receipt_templates")
            .update({
              misses,
              status: misses >= TEMPLATE_MISS_LIMIT ? "failing" : "learned",
              ...(misses >= TEMPLATE_MISS_LIMIT
                ? { total_label: learnTotalLabel(body, total), misses: 0 }
                : {}),
            })
            .eq("vendor_key", templateKey);
        }
      }

      if (isNoise) {
        console.log(
          `[gmail] ${conn.account_email}: ignored (${ignoreReason}) — ${finalVendor ?? senderDomain ?? from}`
        );
      }

      const { data: receipt, error } = await db
        .from("email_receipts")
        .insert({
          source: "gmail",
          external_id: id,
          email_ref: `https://mail.google.com/mail/?authuser=${encodeURIComponent(conn.account_email ?? "")}#all/${id}`,
          mailbox: conn.account_email,
          sender_domain: senderDomain,
          sender_verified: senderVerified,
          card_last4: last4,
          received_at: receivedAt,
          vendor: finalVendor,
          total,
          txn_date_guess: receivedAt.slice(0, 10),
          match_status: isNoise ? "ignored" : "unmatched",
          line_items: llmResult ? ({ llm: llmResult } as unknown as Record<string, unknown>) : null,
        })
        .select("id")
        .single();
      if (error || !receipt) continue;
      if (isNoise) continue;

      await checkWatchlist(db, finalVendor, "email_receipt", {
        emailReceiptId: receipt.id,
        amount: total,
      });

      if (total != null && total > 0) {
        const matched = await matchAgainstExisting(db, receipt.id, finalVendor, total);
        if (!matched) {
          await createAnticipation(db, {
            id: receipt.id,
            vendor: finalVendor,
            total,
            card_last4: last4,
            sender_verified: senderVerified,
          });
        }
      }
    } catch (e: unknown) {
      console.error(`[gmail] message ${id} failed:`, (e as Error).message);
    }
  }

  if (fresh.length) {
    console.log(`[gmail] ${conn.account_email}: ingested ${fresh.length} receipt(s)`);
  }
  await db
    .from("connections")
    .update({ last_polled_at: new Date().toISOString(), status: "ok", last_error: null })
    .eq("id", conn.id);
}

// ---------- expiry (spec §1.7.6: expiry is signal) ----------------------------

export async function expireAnticipations(db: SupabaseClient): Promise<void> {
  const { data: expired } = await db
    .from("anticipated_transactions")
    .update({ status: "expired_review" })
    .eq("status", "open")
    .lt("expires_at", new Date().toISOString())
    .select("id, vendor, amount");
  for (const a of expired ?? []) {
    await notify(
      db,
      `⏰ Anticipated charge never posted: ${a.vendor}`,
      `$${Number(a.amount).toFixed(2)} was expected from a receipt 14 days ago. Possible refund, cancellation, or fraud worth checking.`,
      { anticipatedId: a.id }
    );
  }
  if (expired?.length) {
    await audit(db, "system", "anticipations_expired", "anticipated_transactions", undefined, {
      count: expired.length,
    });
  }
}

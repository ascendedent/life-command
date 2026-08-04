import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit, decryptSecret, merchantKey } from "@finance/shared";

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
  if (topic) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: {
          Title: title,
          Priority: opts.priority === "urgent" ? "urgent" : "default",
          Tags: opts.priority === "urgent" ? "rotating_light" : "moneybag",
        },
        body,
      });
    } catch (e: unknown) {
      console.error("[notify] ntfy failed:", (e as Error).message);
    }
  }
  await db.from("notifications_log").insert({
    rule_id: opts.ruleId ?? null,
    anticipated_transaction_id: opts.anticipatedId ?? null,
    transaction_id: opts.txnId ?? null,
    channel: topic ? "ntfy" : "email",
    content: `${title}: ${body}`,
  });
}

// ---------- parsing helpers ---------------------------------------------------

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(payload: Record<string, unknown>): string {
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
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 20000);
}

function extractTotal(text: string): number | null {
  const labeled = [
    ...text.matchAll(/(?:(?:order|grand|invoice)\s+total|total|amount(?:\s+(?:charged|due|paid))?|charged|paid|payment)[^$\d]{0,40}\$\s?([\d,]+\.\d{2})/gi),
  ];
  if (labeled.length) {
    return Number(labeled[labeled.length - 1][1].replace(/,/g, ""));
  }
  const any = [...text.matchAll(/\$\s?([\d,]+\.\d{2})/g)].map((m) =>
    Number(m[1].replace(/,/g, ""))
  );
  return any.length ? Math.max(...any) : null;
}

// ---------- LLM fallback parse (spec §1.7: optional LLM parse) ----------------

const ReceiptParseSchema = z.object({
  is_purchase_receipt: z
    .boolean()
    .describe("True only for an actual purchase/order/payment confirmation — not shipping updates, newsletters, statements, or mail previews"),
  vendor: z.string().describe("The merchant name, cleanly formatted"),
  total: z.number().nullable().describe("The final amount charged, null if none stated"),
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
      max_tokens: 2000,
      output_config: {
        effort: "low",
        format: zodOutputFormat(ReceiptParseSchema),
      },
      messages: [
        {
          role: "user",
          content: `Classify and parse this email.\nFrom: ${from}\nSubject: ${subject}\n\nBody (text-stripped):\n${body.slice(0, 6000)}`,
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
      let total = extractTotal(`${subject} ${body}`);
      let last4 = extractLast4(body);
      let parsedVendor: string | null = null;
      let llmResult: Awaited<ReturnType<typeof llmParseReceipt>> = null;
      const receivedAt = new Date(Number(msg.internalDate)).toISOString();

      // regex came up empty on a verified sender → let the model read it
      if (total == null && senderVerified) {
        llmResult = await llmParseReceipt(subject, from, body);
        if (llmResult) {
          total = llmResult.total;
          last4 = last4 ?? llmResult.card_last4;
          parsedVendor = llmResult.vendor || null;
        }
      }

      // cross-mailbox duplicate guard: the same receipt CC'd to two linked
      // inboxes arrives with different message ids — don't double-anticipate
      if (total != null) {
        const { data: dupe } = await db
          .from("email_receipts")
          .select("id")
          .eq("vendor", vendor)
          .eq("total", total)
          .gte("received_at", new Date(Date.parse(receivedAt) - 6 * 3600_000).toISOString())
          .lte("received_at", new Date(Date.parse(receivedAt) + 6 * 3600_000).toISOString())
          .limit(1);
        if (dupe?.length) continue;
      }

      const isNoise = llmResult != null && !llmResult.is_purchase_receipt;
      const finalVendor = parsedVendor ?? vendor;

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

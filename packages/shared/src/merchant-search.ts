// Semantic merchant recall.
//
// Answers the question a substring search cannot: "that garden place", "the
// mattress people", "wherever the storage boxes came from". Embeddings run
// locally through Ollama, so a list of everywhere the owner shops never leaves
// the machine — which for this data is not a nice-to-have.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "./db";

const OLLAMA = () => process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

export interface EmbedFailure {
  ok: false;
  error: string;
}

/**
 * Embed a batch of strings.
 *
 * Returns a failure rather than throwing: an embedding model that is not
 * running is a normal state on a machine where Ollama is optional, and the
 * chat should say "semantic search is unavailable" rather than break the turn.
 */
export async function embed(
  inputs: string[]
): Promise<{ ok: true; vectors: number[][] } | EmbedFailure> {
  if (!inputs.length) return { ok: true, vectors: [] };
  try {
    const res = await fetch(`${OLLAMA()}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    });
    if (!res.ok) {
      return { ok: false, error: `embedding model returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings?.length) return { ok: false, error: "no embeddings returned" };
    return { ok: true, vectors: data.embeddings };
  } catch (e) {
    return {
      ok: false,
      error: `no embedding model reachable at ${OLLAMA()} (${(e as Error).message})`,
    };
  }
}

/**
 * Build or refresh the merchant index.
 *
 * Only merchants whose source text changed are re-embedded, so a nightly run
 * costs nothing once the book is steady. The count of transactions is part of
 * the source text on purpose — it is *not* meant to be, which is why it is
 * excluded below; embedding a number would make every merchant drift every
 * time they shopped.
 */
export async function reindexMerchants(
  db: SupabaseClient,
  opts: { batch?: number } = {}
): Promise<{ indexed: number; skipped: number; total: number; error?: string }> {
  const batch = opts.batch ?? 64;

   
  const rows = (await fetchAll<any>(() =>
    db
      .from("transactions")
      .select("id, merchant_clean, merchant, categories (name, category_groups (name))")
      .eq("hidden", false)
      .order("id")
  )) as {
    merchant_clean: string | null;
    merchant: string | null;
    categories: { name?: string; category_groups?: { name?: string } | null } | null;
  }[];

  // A bare merchant name is a poor thing to embed. "1-800-Pack-Rat" contains no
  // word about moving or storage, so a search for "moving and storage company"
  // ranked a wine shop with "Warehouse" in its name above it and never surfaced
  // the actual mover at all. The category the owner's own book already files it
  // under — "Shipping & Postage, Business" — is the signal that was missing.
  //
  // The dominant category is used rather than all of them: a merchant filed
  // three ways would otherwise embed to the average of three unrelated points,
  // which is a place none of them are.
  const counts = new Map<string, number>();
  const categoryVotes = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const name = (r.merchant_clean ?? r.merchant)?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const cat = r.categories?.name;
    const group = r.categories?.category_groups?.name;
    if (cat) {
      const label = group && group !== cat ? `${cat}, ${group}` : cat;
      const votes = categoryVotes.get(name) ?? new Map<string, number>();
      votes.set(label, (votes.get(label) ?? 0) + 1);
      categoryVotes.set(name, votes);
    }
  }

  const sourceTextFor = (merchant: string) => {
    const votes = categoryVotes.get(merchant);
    if (!votes?.size) return merchant;
    const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    return `${merchant} — ${best[0]}`;
  };

  const { data: existing } = await db
    .from("merchant_embeddings")
    .select("merchant, source_text, model");
  const known = new Map((existing ?? []).map((e) => [e.merchant as string, e]));

  // Name plus dominant category is the source text. The transaction count is
  // stored but never embedded: it changes constantly and says nothing about
  // what the merchant *is*, so including it would re-embed the whole book every
  // night for no gain. A category change does re-embed, which is correct — it
  // means the owner reclassified something and the index should follow.
  const todo = [...counts.keys()].filter((m) => {
    const prior = known.get(m);
    return !prior || prior.source_text !== sourceTextFor(m) || prior.model !== EMBED_MODEL;
  });

  let indexed = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const result = await embed(slice.map(sourceTextFor));
    if (!result.ok) {
      return { indexed, skipped: counts.size - indexed, total: counts.size, error: result.error };
    }
    const payload = slice.map((merchant, j) => ({
      merchant,
      embedding: JSON.stringify(result.vectors[j]),
      model: EMBED_MODEL,
      source_text: sourceTextFor(merchant),
      txn_count: counts.get(merchant) ?? 0,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await db.from("merchant_embeddings").upsert(payload, { onConflict: "merchant" });
    if (error) return { indexed, skipped: 0, total: counts.size, error: error.message };
    indexed += slice.length;
  }

  // Counts move even when the name does not, and they are cheap to refresh.
  for (const [merchant, n] of counts) {
    if (todo.includes(merchant)) continue;
    const prior = known.get(merchant);
    if (prior && (prior as { txn_count?: number }).txn_count !== n) {
      await db.from("merchant_embeddings").update({ txn_count: n }).eq("merchant", merchant);
    }
  }

  return { indexed, skipped: counts.size - indexed, total: counts.size };
}

/** Merchants closest in meaning to a description. */
export async function findMerchants(
  db: SupabaseClient,
  query: string,
  opts: { limit?: number; min_similarity?: number } = {}
) {
  const e = await embed([query]);
  if (!e.ok) {
    return {
      query,
      error: `${e.error} — fall back to search_transactions with a merchant substring`,
      matches: [],
    };
  }
  const { data, error } = await db.rpc("match_merchants", {
    query_embedding: JSON.stringify(e.vectors[0]),
    match_count: Math.min(opts.limit ?? 10, 40),
    min_similarity: opts.min_similarity ?? 0.5,
  });
  if (error) return { query, error: error.message, matches: [] };
  return {
    query,
    // Similarity is reported so the model can tell a confident hit from a
    // shrug, and say which it has.
    matches: (data ?? []) as { merchant: string; similarity: number; txn_count: number }[],
  };
}

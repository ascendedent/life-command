"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  attributionFrom,
  CALENDAR_ATTRIBUTION,
  type IncomeAttribution,
} from "@finance/shared/src/pay-period";
import { createClient } from "@/lib/supabase/client";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import {
  indexCategories,
  type CategoryIndex,
  type CategoryMeta,
  type ReportTxn,
} from "@finance/shared/src/reports";

export interface AccountMeta {
  id: string;
  name: string;
  type: string;
  mask: string | null;
  is_business: boolean;
  business_entity: string | null;
}

export interface TagMeta {
  id: string;
  name: string;
  color: string | null;
}

export interface ReportData {
  /** How the owner wants month-end income attributed — see pay-period. */
  attribution: IncomeAttribution;
  txns: ReportTxn[];
  cats: CategoryMeta[];
  catIndex: CategoryIndex;
  accounts: AccountMeta[];
  tags: TagMeta[];
  tagsByTxn: Map<string, Set<string>>;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const PAGE = 1000; // PostgREST caps a response; page until the tail is short

/**
 * Loads everything the Reports tabs aggregate over.
 *
 * `hidden = false` is the only structural filter: splitting a transaction hides
 * the parent and creates children, so hidden-only is exactly "count each dollar
 * once". Filtering on parent_transaction_id instead would drop every split.
 */
export function useReportData(from: string, to: string): ReportData {
  const supabase = useMemo(() => createClient(), []);
  const [txns, setTxns] = useState<ReportTxn[]>([]);
  const [cats, setCats] = useState<CategoryMeta[]>([]);
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [tags, setTags] = useState<TagMeta[]>([]);
  const [tagsByTxn, setTagsByTxn] = useState<Map<string, Set<string>>>(new Map());
  const [attribution, setAttribution] = useState<IncomeAttribution>(CALENDAR_ATTRIBUTION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [
          { data: catRows, error: catErr },
          { data: acctRows },
          { data: tagRows },
          { data: settingsRow },
        ] = await Promise.all([
            supabase
              .from("categories")
              .select("id, name, emoji, group_id, category_groups (name, type)")
              .eq("is_active", true),
            supabase
              .from("accounts")
              .select("id, name, type, mask, is_business, business_entity")
              .order("name"),
            supabase.from("tags").select("id, name, color").order("name"),
            supabase
              .from("app_settings")
              .select("income_attribution, income_shift_from_day")
              .eq("id", 1)
              .maybeSingle(),
          ]);
        if (catErr) throw catErr;
        setAttribution(attributionFrom(settingsRow ?? null));

        const catMeta: CategoryMeta[] = (catRows ?? []).map((c) => {
          const g = c.category_groups as unknown as { name: string; type: string } | null;
          return {
            id: c.id as string,
            name: c.name as string,
            emoji: (c.emoji as string | null) ?? null,
            group_id: c.group_id as string,
            group_name: g?.name ?? "Ungrouped",
            group_type: (g?.type as CategoryMeta["group_type"]) ?? "expense",
          };
        });

        const all: ReportTxn[] = [];
        const tagMap = new Map<string, Set<string>>();
        for (let page = 0; ; page++) {
          const { data, error: txnErr } = await supabase
            .from("transactions")
            .select(
              "id, date, amount, merchant, merchant_clean, category_id, account_id, is_business, business_entity, pending, transaction_tags (tag_id)"
            )
            .gte("date", from)
            .lte("date", to)
            .eq("hidden", false)
            .order("date", { ascending: false })
            .range(page * PAGE, page * PAGE + PAGE - 1);
          if (txnErr) throw txnErr;
          const rows = data ?? [];
          for (const r of rows) {
            all.push({
              id: r.id as string,
              date: r.date as string,
              amount: Number(r.amount),
              merchant: (r.merchant as string | null) ?? null,
              merchant_clean: (r.merchant_clean as string | null) ?? null,
              category_id: (r.category_id as string | null) ?? null,
              account_id: r.account_id as string,
              is_business: Boolean(r.is_business),
              business_entity: (r.business_entity as string | null) ?? null,
              pending: Boolean(r.pending),
            });
            const links = (r.transaction_tags ?? []) as unknown as { tag_id: string }[];
            if (links.length) tagMap.set(r.id as string, new Set(links.map((l) => l.tag_id)));
          }
          if (rows.length < PAGE) break;
        }

        if (cancelled) return;
        setCats(catMeta);
        setAccounts((acctRows ?? []) as AccountMeta[]);
        setTags((tagRows ?? []) as TagMeta[]);
        setTxns(all);
        setTagsByTxn(tagMap);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, from, to, nonce]);

  const catIndex = useMemo(() => indexCategories(cats), [cats]);

  return { txns, cats, catIndex, accounts, tags, tagsByTxn, attribution, loading, error, reload };
}

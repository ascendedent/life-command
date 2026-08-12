"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { Landmark, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface LinkedAccount {
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  mask: string | null;
  is_business: boolean;
  business_entity: string | null;
}

/**
 * Plaid Link locks background scrolling (overflow:hidden on body/html) while
 * its iframe overlay is open, and releases the lock during teardown. Clearing
 * the token — or unmounting — destroys the handler, and if that happens before
 * teardown finishes the lock survives: the page then cannot scroll at all, by
 * wheel or keyboard, until it is reloaded.
 *
 * Releasing it ourselves is idempotent and safe even while Link is still open,
 * because the overlay is fixed-position and does not depend on the lock.
 */
function releaseScrollLock() {
  if (typeof document === "undefined") return;
  for (const el of [document.body, document.documentElement]) {
    el.style.removeProperty("overflow");
    el.style.removeProperty("position");
  }
}

/**
 * "Link institution" button -> Plaid Link -> exchange -> business-flag step.
 * Pass institutionId to run in relink/update mode for a broken connection.
 */
export function LinkInstitution({
  institutionId,
  compact = false,
}: {
  institutionId?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flagStep, setFlagStep] = useState<LinkedAccount[] | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string; is_primary: boolean }[]>([]);
  const [memberId, setMemberId] = useState<string>("");

  // Whose bank is being linked. Only worth asking once the household has more
  // than one person in it.
  useEffect(() => {
    if (institutionId) return; // relink keeps the member it already has
    createClient()
      .from("household_members")
      .select("id, name, is_primary")
      .order("is_primary", { ascending: false })
      .order("name")
      .then(({ data }) => {
        const rows = data ?? [];
        setMembers(rows);
        setMemberId(rows.find((m) => m.is_primary)?.id ?? rows[0]?.id ?? "");
      });
  }, [institutionId]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/plaid/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        institutionId ? { institution_id: institutionId } : { member_id: memberId || null }
      ),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create link token");
      return;
    }
    setLinkToken(data.link_token);
  }, [institutionId, memberId]);

  const onSuccess = useCallback(
    async (
      publicToken: string | null,
      metadata: { institution?: { name: string; institution_id: string } | null }
    ) => {
      setLinkToken(null);
      releaseScrollLock();
      if (!publicToken) return;
      if (institutionId) {
        // relink/update mode: token unchanged, just refresh
        router.refresh();
        return;
      }
      setBusy(true);
      const res = await fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_token: publicToken,
          institution: metadata.institution,
          member_id: memberId || null,
        }),
      });
      const data = await res.json();
      setBusy(false);
      if (!res.ok) {
        setError(data.error ?? "Exchange failed");
        return;
      }
      setFlagStep(data.accounts);
    },
    [institutionId, router, memberId]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      releaseScrollLock();
    },
  });

  // Opening during render fires on every re-render and races React's commit;
  // an effect opens exactly once per issued token.
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  // Last line of defence: if this unmounts while Link is mid-teardown (the
  // success path swaps in the business-flag dialog), release the lock anyway.
  useEffect(() => releaseScrollLock, []);

  if (flagStep) {
    return (
      <BusinessFlagDialog
        accounts={flagStep}
        onDone={() => {
          setFlagStep(null);
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className={compact ? "inline-flex" : "flex flex-col gap-1"}>
      {/* Plaid starts a clean session per member, so this has to be chosen
          before the token is issued rather than after the accounts arrive. */}
      {!institutionId && members.length > 1 && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Linking for
          <select
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button
        variant={institutionId ? "outline" : "default"}
        size="sm"
        onClick={start}
        disabled={busy || (linkToken != null && !ready)}
      >
        {busy || (linkToken != null && !ready) ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : institutionId ? (
          <RefreshCw className="h-4 w-4" />
        ) : (
          <Landmark className="h-4 w-4" />
        )}
        {institutionId ? "Relink" : "Link institution"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function BusinessFlagDialog({
  accounts,
  onDone,
}: {
  accounts: LinkedAccount[];
  onDone: () => void;
}) {
  const [rows, setRows] = useState(accounts);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    for (const row of rows) {
      const original = accounts.find((a) => a.id === row.id);
      if (
        original &&
        (original.is_business !== row.is_business ||
          original.business_entity !== row.business_entity)
      ) {
        await fetch(`/api/accounts/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            is_business: row.is_business,
            business_entity: row.business_entity,
          }),
        });
      }
    }
    setSaving(false);
    onDone();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border bg-card p-5">
        <h2 className="text-sm font-semibold">Institution linked</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Flag any business accounts — every transaction they sync will
          auto-tag as business and request a receipt. Initial sync is queued.
        </p>
        <div className="mt-4 space-y-2">
          {rows.map((a, i) => (
            <div key={a.id} className="flex items-center gap-3 rounded-md border p-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{a.name}</p>
                <p className="text-xs text-muted-foreground">
                  {a.type}
                  {a.subtype ? ` · ${a.subtype}` : ""}
                  {a.mask ? ` · …${a.mask}` : ""}
                </p>
              </div>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={a.is_business}
                  onChange={(e) => {
                    const next = [...rows];
                    next[i] = { ...a, is_business: e.target.checked };
                    setRows(next);
                  }}
                />
                Business
              </label>
              {a.is_business && (
                <Input
                  placeholder="Entity"
                  value={a.business_entity ?? ""}
                  onChange={(e) => {
                    const next = [...rows];
                    next[i] = { ...a, business_entity: e.target.value };
                    setRows(next);
                  }}
                  className="h-7 w-36 text-xs"
                />
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <Badge variant="secondary">initial sync queued</Badge>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Done"}
          </Button>
        </div>
      </div>
    </div>
  );
}

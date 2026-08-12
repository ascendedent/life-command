"use client";

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Who is in the household, and which accounts are whose.
 *
 * Linking a partner's bank always worked — Plaid Link takes any credentials —
 * but the accounts then joined one undifferentiated pile. This is the missing
 * half: an attribute on each account so "what do we have" and "what do I have"
 * can be answered from the same data.
 *
 * Not a second login. There is still one owner and one set of RLS policies;
 * a member is a label on an account, not an identity that can sign in.
 */

interface Member {
  id: string;
  name: string;
  is_primary: boolean;
}

interface AccountRow {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  member_id: string | null;
  institutions?: { name: string } | null;
}

export function HouseholdMembers() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: m }, { data: a }] = await Promise.all([
      supabase.from("household_members").select("id, name, is_primary").order("is_primary", { ascending: false }).order("name"),
      supabase
        .from("accounts")
        .select("id, name, mask, type, member_id, institutions (name)")
        .order("name"),
    ]);
    setMembers((m ?? []) as Member[]);
    setAccounts((a ?? []) as unknown as AccountRow[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addMember() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: e } = await supabase.from("household_members").insert({ name });
    setBusy(false);
    if (e) {
      setError(e.message.includes("duplicate") ? `"${name}" already exists.` : e.message);
      return;
    }
    await supabase.from("audit_log").insert({
      actor: "user", action: "household_member_added", entity: "household_members",
      detail: { name },
    });
    setNewName("");
    load();
  }

  async function removeMember(m: Member) {
    if (m.is_primary) {
      setError("The primary member cannot be removed.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    // Accounts fall back to unassigned rather than disappearing — the FK is
    // ON DELETE SET NULL, and unassigned still counts toward the household.
    const { error: e } = await supabase.from("household_members").delete().eq("id", m.id);
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    await supabase.from("audit_log").insert({
      actor: "user", action: "household_member_removed", entity: "household_members",
      detail: { name: m.name },
    });
    load();
  }

  async function assign(accountId: string, memberId: string) {
    const supabase = createClient();
    await supabase
      .from("accounts")
      .update({ member_id: memberId || null })
      .eq("id", accountId);
    setAccounts((prev) =>
      prev.map((a) => (a.id === accountId ? { ...a, member_id: memberId || null } : a))
    );
  }

  const countFor = (id: string | null) =>
    accounts.filter((a) => a.member_id === id).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" /> Household
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Link anyone&apos;s bank through <em>Link institution</em> as usual, then say whose
          accounts they are. Unassigned accounts still count toward household totals — a
          missing label never removes money from the books.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {(members ?? []).map((m) => (
            <span
              key={m.id}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm"
            >
              {m.name}
              <span className="text-xs text-muted-foreground">
                {countFor(m.id)} account{countFor(m.id) === 1 ? "" : "s"}
              </span>
              {!m.is_primary && (
                <button
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => removeMember(m)}
                  disabled={busy}
                  title="Remove this member"
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addMember()}
              placeholder="Add someone"
              className="h-8 w-36"
            />
            <Button size="sm" variant="outline" onClick={addMember} disabled={busy || !newName.trim()}>
              Add
            </Button>
          </span>
        </div>

        <div className="space-y-1.5">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 truncate">
                {a.name}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {a.institutions?.name ?? ""}
                  {a.mask ? ` · …${a.mask}` : ""}
                </span>
              </span>
              <select
                value={a.member_id ?? ""}
                onChange={(e) => assign(a.id, e.target.value)}
                className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Unassigned</option>
                {(members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="text-sm text-muted-foreground">No accounts linked yet.</p>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

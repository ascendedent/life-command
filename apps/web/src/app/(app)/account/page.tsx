"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, KeyRound, Mail, ShieldCheck, TimerReset, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface GmailMeta {
  query?: string;
  labels?: string[];
  use_purchases_category?: boolean;
}

const cnChip = (on: boolean) =>
  `rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
    on
      ? "border-primary bg-primary/15 text-primary"
      : "border-input text-muted-foreground hover:text-foreground"
  }`;

const LOCK_OPTIONS = [
  { value: 0, label: "Never" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 480, label: "8 hours" },
  { value: 1440, label: "24 hours" },
];

export default function AccountPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [totpEnrolled, setTotpEnrolled] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [lockMinutes, setLockMinutes] = useState<number | null>(null);
  const [incomeMode, setIncomeMode] = useState<string | null>(null);
  const [incomeDay, setIncomeDay] = useState<number>(26);
  const [incomeSaved, setIncomeSaved] = useState(false);
  const [lockSaved, setLockSaved] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [gmail, setGmail] = useState<
    { id: string; account_email: string | null; status: string; connected_at: string; meta: GmailMeta | null }[] | "loading"
  >("loading");
  const [labelOptions, setLabelOptions] = useState<Map<string, string[] | "loading" | "error">>(new Map());
  const supabaseMemo = useMemo(() => createClient(), []);

  async function loadGmail() {
    const { data } = await supabaseMemo
      .from("connections")
      .select("id, account_email, status, connected_at, meta")
      .eq("provider", "gmail")
      .order("connected_at");
    setGmail(data ?? []);
  }

  async function loadLabels(connId: string) {
    setLabelOptions((m) => new Map(m).set(connId, "loading"));
    const res = await fetch(`/api/gmail/labels?id=${connId}`);
    const data = await res.json();
    setLabelOptions((m) =>
      new Map(m).set(connId, res.ok ? (data.labels as string[]) : "error")
    );
  }

  /** Selected labels + category flag → the Gmail query the poller runs. */
  function buildQuery(meta: GmailMeta): string {
    const parts: string[] = [];
    for (const l of meta.labels ?? []) {
      parts.push(`label:${l.toLowerCase().replace(/[/\s]+/g, "-")}`);
    }
    if (meta.use_purchases_category) parts.push("category:purchases");
    return parts.join(" OR ");
  }

  async function saveMeta(id: string, meta: GmailMeta) {
    const query = buildQuery(meta);
    const next: GmailMeta | null =
      meta.labels?.length || meta.use_purchases_category
        ? { ...meta, query }
        : meta.query
          ? { query: meta.query }
          : null;
    await supabaseMemo.from("connections").update({ meta: next }).eq("id", id);
    loadGmail();
  }

  async function saveCustomQuery(id: string, query: string) {
    // hand-written query overrides label selection entirely
    await supabaseMemo
      .from("connections")
      .update({ meta: query.trim() ? { query: query.trim() } : null })
      .eq("id", id);
    loadGmail();
  }

  async function disconnectGmail(id: string, email: string | null) {
    await supabaseMemo.from("connections").delete().eq("id", id);
    await supabaseMemo.from("audit_log").insert({
      actor: "user",
      action: "gmail_disconnected",
      entity: "connections",
      detail: { email },
    });
    loadGmail();
  }

  useEffect(() => {
    loadGmail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    supabase.auth.mfa
      .listFactors()
      .then(({ data }) =>
        setTotpEnrolled(!!data?.totp.some((f) => f.status === "verified"))
      );
    supabase
      .from("app_settings")
      .select("auto_lock_minutes, income_attribution, income_shift_from_day")
      .eq("id", 1)
      .maybeSingle()
      .then(({ data }) => {
        setLockMinutes(data?.auto_lock_minutes ?? 0);
        setIncomeMode(data?.income_attribution ?? "calendar");
        setIncomeDay(data?.income_shift_from_day ?? 26);
      });
  }, []);

  async function handleLockChange(minutes: number) {
    setLockMinutes(minutes);
    setLockSaved(false);
    setLockError(null);
    const supabase = createClient();
    const { error } = await supabase
      .from("app_settings")
      .upsert({ id: 1, auto_lock_minutes: minutes }, { onConflict: "id" });
    if (error) {
      setLockError(error.message);
      return;
    }
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "auto_lock_changed",
      entity: "app_settings",
      detail: { auto_lock_minutes: minutes },
    });
    setLockSaved(true);
  }

  async function handleIncomeChange(mode: string, day: number) {
    setIncomeMode(mode);
    setIncomeDay(day);
    setIncomeSaved(false);
    const supabase = createClient();
    const { error } = await supabase
      .from("app_settings")
      .upsert(
        { id: 1, income_attribution: mode, income_shift_from_day: day },
        { onConflict: "id" }
      );
    if (error) return;
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "income_attribution_changed",
      entity: "app_settings",
      detail: { income_attribution: mode, income_shift_from_day: day },
    });
    setIncomeSaved(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (password.length < 8) {
      setError("Use at least 8 characters (12+ recommended).");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    const supabase = createClient();

    // Re-authenticate with a fresh TOTP code before allowing the change —
    // an unlocked session alone is not enough to rotate the password.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp.find((f) => f.status === "verified");
    if (!factor) {
      setBusy(false);
      setError("No verified TOTP factor found.");
      return;
    }
    const { error: totpError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: totpCode.trim(),
    });
    if (totpError) {
      setBusy(false);
      setError(`Authenticator code rejected: ${totpError.message}`);
      setTotpCode("");
      return;
    }

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "password_changed",
      entity: "auth",
      detail: { totp_reauth: true },
    });
    setBusy(false);
    setSuccess(true);
    setPassword("");
    setConfirm("");
    setTotpCode("");
  }

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-xl font-semibold">Account</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <UserRound className="h-3.5 w-3.5" /> Identity
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="font-mono text-sm">{email ?? "…"}</p>
          <div className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {totpEnrolled === null ? (
              <span className="text-muted-foreground">checking TOTP…</span>
            ) : totpEnrolled ? (
              <Badge>TOTP enabled</Badge>
            ) : (
              <Badge variant="destructive">TOTP missing</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5" /> Change password
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="totp-code">Authenticator code</Label>
              <Input
                id="totp-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000000"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="font-mono tracking-[0.3em]"
                required
              />
              <p className="text-xs text-muted-foreground">
                A fresh TOTP code is required to change the password.
              </p>
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            {success && (
              <p className="text-sm text-primary" role="status">
                Password updated. Your current session stays signed in.
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Updating…" : "Update password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" /> Income attribution
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            A paycheque landing on the 30th is usually spent on the month about
            to start. Counting it in the month it posted inflates that month and
            leaves the next one looking like it began empty. Expenses are never
            moved — only income shifts.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={incomeMode ?? ""}
              disabled={incomeMode === null}
              onChange={(e) => handleIncomeChange(e.target.value, incomeDay)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {incomeMode === null && <option value="">loading…</option>}
              <option value="calendar">Calendar month (matches your statement)</option>
              <option value="forward_shift">Month-end pay counts toward next month</option>
            </select>
            {incomeMode === "forward_shift" && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                from day
                <select
                  value={incomeDay}
                  onChange={(e) => handleIncomeChange("forward_shift", Number(e.target.value))}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {Array.from({ length: 17 }, (_, i) => 15 + i).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {incomeSaved && <span className="text-sm text-primary">Saved</span>}
          </div>
          {incomeMode === "forward_shift" && (
            <p className="text-xs text-muted-foreground">
              Income posted on or after the {incomeDay}
              {incomeDay === 1 ? "st" : incomeDay === 2 ? "nd" : incomeDay === 3 ? "rd" : "th"} counts
              toward the following month. A 15th-and-30th schedule then splits the way it is spent.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <TimerReset className="h-3.5 w-3.5" /> Auto-lock
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Require a fresh authenticator code when the last one is older than
            this. Applies immediately, even to the current session.
          </p>
          <div className="flex items-center gap-3">
            <select
              value={lockMinutes ?? ""}
              disabled={lockMinutes === null}
              onChange={(e) => handleLockChange(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {lockMinutes === null && <option value="">loading…</option>}
              {LOCK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {lockSaved && <span className="text-sm text-primary">Saved</span>}
          </div>
          {lockError && (
            <p className="text-sm text-destructive" role="alert">
              {lockError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5" /> Gmail receipts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Read-only Gmail access pulls receipt emails for instant anticipated
            transactions and automatic receipt matching. Interim path until the
            Aldyn Receipts API is live.
          </p>
          {gmail === "loading" ? (
            <p className="text-xs text-muted-foreground">checking…</p>
          ) : (
            <div className="space-y-2">
              {gmail.map((conn) => {
                const options = labelOptions.get(conn.id);
                const selected = new Set(conn.meta?.labels ?? []);
                return (
                  <div key={conn.id} className="space-y-2 rounded-md border p-2.5">
                    <div className="flex items-center gap-3">
                      <Badge>{conn.account_email ?? "connected"}</Badge>
                      <span className="text-xs text-muted-foreground">
                        since {new Date(conn.connected_at).toLocaleDateString()}
                        {conn.status !== "ok" && (
                          <span className="text-destructive"> · {conn.status}</span>
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-destructive"
                        onClick={() => disconnectGmail(conn.id, conn.account_email)}
                      >
                        Disconnect
                      </Button>
                    </div>

                    {options === undefined ? (
                      <Button variant="outline" size="sm" onClick={() => loadLabels(conn.id)}>
                        Choose receipt labels
                      </Button>
                    ) : options === "loading" ? (
                      <p className="text-xs text-muted-foreground">loading labels…</p>
                    ) : options === "error" ? (
                      <p className="text-xs text-destructive">could not load labels — try again</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {options.map((label) => {
                          const on = selected.has(label);
                          return (
                            <button
                              key={label}
                              onClick={() => {
                                const next = new Set(selected);
                                if (on) next.delete(label);
                                else next.add(label);
                                saveMeta(conn.id, {
                                  labels: [...next],
                                  use_purchases_category: conn.meta?.use_purchases_category,
                                });
                              }}
                              className={cnChip(on)}
                            >
                              {label}
                            </button>
                          );
                        })}
                        <button
                          onClick={() =>
                            saveMeta(conn.id, {
                              labels: [...selected],
                              use_purchases_category: !conn.meta?.use_purchases_category,
                            })
                          }
                          className={cnChip(!!conn.meta?.use_purchases_category)}
                          title="Gmail's automatic purchases category — catches most receipts with zero setup"
                        >
                          ✨ Purchases (auto)
                        </button>
                      </div>
                    )}

                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        advanced: custom query
                      </summary>
                      <Input
                        defaultValue={conn.meta?.query ?? ""}
                        placeholder="blank = default receipt-subject search"
                        onBlur={(e) => {
                          if ((e.target.value ?? "") !== (conn.meta?.query ?? "")) {
                            saveCustomQuery(conn.id, e.target.value);
                          }
                        }}
                        className="mt-1 h-8 font-mono text-xs"
                      />
                    </details>
                  </div>
                );
              })}
              <Button size="sm" onClick={() => (window.location.href = "/api/gmail/connect")}>
                {gmail.length ? "Connect another account" : "Connect Gmail"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

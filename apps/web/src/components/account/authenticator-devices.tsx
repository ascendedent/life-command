"use client";

import { useCallback, useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Enrol more than one authenticator.
 *
 * TOTP secrets are shown once, at enrolment, and never again — so a phone that
 * breaks or gets replaced takes the only way in with it. Supabase supports
 * several TOTP factors per user; the app only ever created the first one, and
 * the alternative was unenrolling the working device and re-enrolling, which
 * means a window with no second factor at all and a real chance of lockout.
 *
 * Adding and removing a device both re-verify with a fresh code from a device
 * already enrolled, the same rule the password change follows: an unlocked
 * session is not on its own enough to change how the account is secured.
 * Removing the last verified factor is refused outright — that is not removing
 * a device, it is turning MFA off, and it should not happen by accident.
 */

interface Factor {
  id: string;
  friendly_name?: string;
  status: string;
  created_at: string;
}

export function AuthenticatorDevices() {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [mode, setMode] = useState<"idle" | "enrolling">("idle");
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error: e } = await supabase.auth.mfa.listFactors();
    if (e) {
      setError(e.message);
      return;
    }
    setFactors((data?.totp ?? []).filter((f) => f.status === "verified") as Factor[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function startEnroll() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();

    // An abandoned unverified factor from a previous attempt blocks a new
    // enrolment, and it is not protecting anything — clear it first.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of existing?.all ?? []) {
      if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }

    const name = deviceName.trim() || `Device ${new Date().toISOString().slice(0, 10)}`;
    const { data, error: e } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: name,
    });
    setBusy(false);
    if (e || !data) {
      setError(e?.message ?? "Could not start enrolment.");
      return;
    }
    setPendingId(data.id);
    setQr(data.totp.qr_code);
    setSecret(data.totp.secret);
    setMode("enrolling");
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingId) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: pendingId,
      code: code.trim(),
    });
    setBusy(false);
    if (verifyError) {
      setError(`Code rejected: ${verifyError.message}`);
      setCode("");
      return;
    }
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "mfa_device_added",
      entity: "auth",
      detail: { friendly_name: deviceName.trim() || null },
    });
    setMode("idle");
    setQr(null);
    setSecret(null);
    setPendingId(null);
    setCode("");
    setDeviceName("");
    setNotice("Device added. Both authenticators now work.");
    load();
  }

  async function removeDevice(factor: Factor) {
    if ((factors?.length ?? 0) <= 1) {
      setError("This is the only authenticator. Add another before removing it.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: e } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    await supabase.from("audit_log").insert({
      actor: "user",
      action: "mfa_device_removed",
      entity: "auth",
      detail: { factor_id: factor.id, friendly_name: factor.friendly_name ?? null },
    });
    setNotice("Device removed.");
    load();
  }

  const qrSrc = qr
    ? qr.startsWith("data:")
      ? qr
      : `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Smartphone className="h-3.5 w-3.5" /> Authenticator devices
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Each device holds its own secret and any of them can unlock the app. Enrol a
          second one before you need it — a TOTP secret is shown only at enrolment, so a
          lost phone with no backup means starting over from the database.
        </p>

        {factors === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="space-y-1.5">
            {factors.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span>
                  {f.friendly_name || "Authenticator"}
                  <span className="ml-2 text-xs text-muted-foreground">
                    added {new Date(f.created_at).toLocaleDateString()}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || factors.length <= 1}
                  title={
                    factors.length <= 1
                      ? "Add another device before removing this one"
                      : "Remove this device"
                  }
                  onClick={() => removeDevice(f)}
                >
                  Remove
                </Button>
              </li>
            ))}
            {factors.length === 0 && (
              <li className="text-sm text-muted-foreground">No authenticator enrolled.</li>
            )}
          </ul>
        )}

        {mode === "idle" ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="device-name">Name (optional)</Label>
              <Input
                id="device-name"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="Backup phone"
                className="h-9 w-48"
              />
            </div>
            <Button size="sm" onClick={startEnroll} disabled={busy}>
              {busy ? "Working…" : "Add a device"}
            </Button>
          </div>
        ) : (
          <form onSubmit={confirmEnroll} className="space-y-3">
            {qrSrc && (
              <div className="flex justify-center rounded-md bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrSrc} alt="TOTP enrolment QR code" width={180} height={180} />
              </div>
            )}
            {secret && (
              <p className="break-all text-center font-mono text-xs text-muted-foreground">
                {secret}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Scan this on the new device, then enter the code it shows. Nothing is enrolled
              until the code is accepted, so your current authenticator keeps working
              whatever happens here.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="enroll-code">Code from the new device</Label>
              <Input
                id="enroll-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="h-9 w-32 font-mono"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || code.length !== 6}>
                {busy ? "Verifying…" : "Confirm"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode("idle");
                  setQr(null);
                  setSecret(null);
                  setPendingId(null);
                  setCode("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {notice && <p className="text-sm text-primary">{notice}</p>}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

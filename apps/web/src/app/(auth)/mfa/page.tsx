"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";

type Mode = "loading" | "enroll" | "challenge";

/**
 * A TOTP enrolment in progress, held across reloads.
 *
 * sessionStorage rather than localStorage: this is a secret, it is already on
 * screen as a QR code and in text beneath it, and it should not outlive the
 * tab. It is deleted the moment the factor verifies.
 */
interface PendingEnrollment {
  factorId: string;
  qr: string;
  secret: string;
}

const PENDING_KEY = "lc.mfa.pending";

function readPendingEnrollment(): PendingEnrollment | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingEnrollment;
    return p.factorId && p.secret ? p : null;
  } catch {
    return null;
  }
}

function writePendingEnrollment(p: PendingEnrollment) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* private mode, storage disabled — enrolment still works, just not resumable */
  }
}

function clearPendingEnrollment() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to clean up */
  }
}

export default function MfaPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoLocked, setAutoLocked] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setAutoLocked(new URLSearchParams(window.location.search).has("locked"));

    async function init() {
      const supabase = createClient();
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) {
        setError(error.message);
        return;
      }

      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) {
        setFactorId(verified.id);
        setMode("challenge");
        return;
      }

      // Reloading this page used to rotate the secret.
      //
      // Enrolment cleared every unverified factor and issued a fresh one on
      // each mount, so a refresh — or a back-navigation, or scanning the code
      // and then wandering off to fetch the phone — silently invalidated the QR
      // that had just been scanned. The authenticator kept the old secret, the
      // server held a new one, and every code from then on was wrong with no
      // indication why. It cost a real enrolment before anyone worked it out.
      //
      // A pending enrolment is now remembered and reused: the same factor, the
      // same secret, across as many reloads as it takes. Rotation only happens
      // when there is nothing to resume.
      const pending = readPendingEnrollment();
      const stillOpen =
        pending && data.all.find((f) => f.id === pending.factorId && f.status === "unverified");
      if (pending && stillOpen) {
        setFactorId(pending.factorId);
        setQr(pending.qr);
        setSecret(pending.secret);
        setMode("enroll");
        return;
      }

      // Nothing to resume: clear abandoned factors so enroll doesn't collide.
      clearPendingEnrollment();
      for (const f of data.all) {
        if (f.status === "unverified") {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }

      const { data: enrollData, error: enrollError } =
        await supabase.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: "Authenticator",
        });
      if (enrollError) {
        setError(enrollError.message);
        return;
      }
      setFactorId(enrollData.id);
      setQr(enrollData.totp.qr_code);
      setSecret(enrollData.totp.secret);
      writePendingEnrollment({
        factorId: enrollData.id,
        qr: enrollData.totp.qr_code,
        secret: enrollData.totp.secret,
      });
      setMode("enroll");
    }

    init();
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    setBusy(false);
    if (error) {
      // The overwhelmingly common cause is an older entry for this app still
      // sitting in the authenticator — after a database restore or a re-enrol
      // it generates perfectly valid codes for a secret the server no longer
      // holds. Say so, because "Invalid TOTP code" alone sends people hunting
      // for a clock problem.
      setError(
        `${error.message} — if your authenticator has an older entry for this app, delete it and scan the code above again.`
      );
      setCode("");
      return;
    }
    clearPendingEnrollment();
    router.push("/");
    router.refresh();
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const qrSrc = qr
    ? qr.startsWith("data:")
      ? qr
      : `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`
    : null;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-3 p-6">
          <div className="flex items-center gap-2 text-primary">
            <ShieldCheck className="h-5 w-5" />
            <span className="font-mono text-sm font-semibold tracking-widest">
              TWO-FACTOR AUTH
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {mode === "enroll"
              ? "TOTP is required. Scan the QR code with your authenticator app, then enter the 6-digit code."
              : mode === "challenge"
                ? autoLocked
                  ? "Auto-lock engaged — enter a fresh 6-digit code to continue."
                  : "Enter the 6-digit code from your authenticator app."
                : "Loading…"}
          </p>
        </CardHeader>
        <CardContent className="space-y-4 p-6 pt-0">
          {mode === "enroll" && qrSrc && (
            <div className="space-y-3">
              <div className="flex justify-center rounded-md bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrSrc} alt="TOTP enrollment QR code" width={180} height={180} />
              </div>
              {secret && (
                <p className="break-all text-center font-mono text-xs text-muted-foreground">
                  {secret}
                </p>
              )}
              <p className="text-center text-xs text-muted-foreground">
                Delete any older entry for this app first — an old one still
                produces codes, and none of them will work.
              </p>
            </div>
          )}

          {mode !== "loading" && (
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="code">Authentication code</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="text-center font-mono text-lg tracking-[0.5em]"
                  required
                  autoFocus
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={busy || code.trim().length < 6}
              >
                {busy ? "Verifying…" : "Verify"}
              </Button>
            </form>
          )}

          {error && mode === "loading" && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={handleSignOut}
          >
            Sign out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

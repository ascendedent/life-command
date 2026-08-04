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

      // Clear abandoned unverified factors so enroll doesn't collide.
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
      setError(error.message);
      setCode("");
      return;
    }
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

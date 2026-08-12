import Link from "next/link";
import { redirect } from "next/navigation";
import { Terminal } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { SidebarNav } from "@/components/sidebar";
import { LogoutButton } from "@/components/logout-button";
import { ActiveJobsIndicator } from "@/components/active-jobs-indicator";
import { AutoLockTicker } from "@/components/auto-lock-ticker";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // TOTP is mandatory (spec §7.2): aal2 or you don't get in.
  const { data: aal } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") redirect("/mfa");

  // Auto-lock: when the last TOTP challenge is older than the configured
  // cadence, demand a fresh code. UI-level lock for walk-up protection — the
  // underlying Supabase session itself stays valid until sign-out.
  const { data: settings } = await supabase
    .from("app_settings")
    .select("auto_lock_minutes")
    .eq("id", 1)
    .maybeSingle();
  const lockMinutes = settings?.auto_lock_minutes ?? 0;
  if (lockMinutes > 0) {
    // AMR entries may be bare strings in older shapes; only entries carrying
    // a timestamp can be measured — with none, fail open (no lock loop).
    const totpStamps = (aal?.currentAuthenticationMethods ?? [])
      .map((m) =>
        typeof m === "string" ? { method: m, timestamp: 0 } : m
      )
      .filter((m) => m.method.includes("totp") && m.timestamp > 0)
      .map((m) => m.timestamp);
    if (totpStamps.length > 0) {
      const ageSeconds = Date.now() / 1000 - Math.max(...totpStamps);
      if (ageSeconds > lockMinutes * 60) redirect("/mfa?locked=1");
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r bg-card/50 max-md:hidden">
        <div className="flex items-center gap-2 px-4 py-4 text-primary">
          <Terminal className="h-5 w-5" />
          <span className="font-mono text-xs font-semibold tracking-widest">
            LIFE COMMAND
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          <SidebarNav />
        </div>
        <div className="border-t p-2">
          <div className="mb-1.5 empty:mb-0">
            <ActiveJobsIndicator />
          </div>
          <Link
            href="/account"
            className="block truncate rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            title="Account settings"
          >
            {user.email}
          </Link>
          <LogoutButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">{children}</main>
      <AutoLockTicker />
    </div>
  );
}

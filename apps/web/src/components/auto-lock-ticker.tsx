"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the server-side layout guard once a minute so the auto-lock
 * (TOTP freshness check) engages even while the app sits idle.
 */
export function AutoLockTicker() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60_000);
    return () => clearInterval(id);
  }, [router]);

  return null;
}

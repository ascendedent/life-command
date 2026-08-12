"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * What the worker is doing right now, read from the database.
 *
 * A manual run has always executed in the worker, not the browser — clicking
 * "Run analysis now" queues a row and the worker picks it up. But the page
 * held "am I running" in React state and polled with a setInterval, so
 * navigating away threw both of them out: the work carried on invisibly, and
 * coming back showed an idle button over a job still in flight.
 *
 * Deriving it from sync_jobs makes the truth survive navigation, reloads, and
 * a second tab, because the state was never really the page's to own.
 */

export interface ActiveJob {
  id: string;
  type: string;
  status: "pending" | "running";
  requested_at: string;
  started_at: string | null;
}

const LABELS: Record<string, string> = {
  agent_run: "Analysis",
  enrich: "Enrichment",
  goal_match: "Goal matching",
  recap_weekly: "Weekly recap",
  recap_monthly: "Monthly recap",
  sync_all: "Sync",
  sync_item: "Sync",
};

export function jobLabel(type: string): string {
  return LABELS[type] ?? type;
}

export function useActiveJobs(intervalMs = 3000) {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    let alive = true;
    const supabase = createClient();

    async function poll() {
      const { data } = await supabase
        .from("sync_jobs")
        .select("id, type, status, requested_at, started_at")
        .in("status", ["pending", "running"])
        .order("requested_at");
      if (!alive) return;
      setJobs((data ?? []) as ActiveJob[]);
      setLoaded(true);
    }

    poll();
    const timer = setInterval(poll, intervalMs);
    // Catch up immediately when the tab is focused again rather than waiting
    // out an interval that browsers throttle in the background anyway.
    const onVisible = () => document.visibilityState === "visible" && poll();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [intervalMs, nudge]);

  return {
    jobs,
    loaded,
    /** Re-read immediately, for right after queueing something. */
    refresh: () => setNudge((n) => n + 1),
    isRunning: (type: string) => jobs.some((j) => j.type === type),
    busy: jobs.length > 0,
  };
}

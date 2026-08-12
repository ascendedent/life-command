"use client";

import { Loader2 } from "lucide-react";
import { useActiveJobs, jobLabel } from "@/lib/use-active-jobs";

/**
 * A background job is running somewhere — say so on every page.
 *
 * The Agent page knew when it had started an analysis and no other page did,
 * so leaving it made an in-flight run invisible. It is the worker's work, not
 * that page's, and it should be visible wherever the owner happens to be.
 */
export function ActiveJobsIndicator() {
  const { jobs } = useActiveJobs();
  if (!jobs.length) return null;

  const names = [...new Set(jobs.map((j) => jobLabel(j.type)))];
  return (
    <span
      className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs"
      title={jobs
        .map((j) => `${jobLabel(j.type)} — ${j.status}`)
        .join("\n")}
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      {names.join(", ")} running
      {jobs.length > names.length ? ` (${jobs.length})` : ""}
    </span>
  );
}

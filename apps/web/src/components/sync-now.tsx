"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SyncNow() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "queued" | "running" | "error">("idle");

  async function run() {
    const supabase = createClient();
    setState("queued");
    const { data: job, error } = await supabase
      .from("sync_jobs")
      .insert({ type: "sync_all", requested_by: "user" })
      .select("id")
      .single();
    if (error || !job) {
      setState("error");
      return;
    }
    const poll = setInterval(async () => {
      const { data } = await supabase
        .from("sync_jobs")
        .select("status")
        .eq("id", job.id)
        .single();
      if (data?.status === "running") setState("running");
      if (data?.status === "done" || data?.status === "error") {
        clearInterval(poll);
        setState(data.status === "error" ? "error" : "idle");
        router.refresh();
      }
    }, 3000);
  }

  const active = state === "queued" || state === "running";
  return (
    <Button variant="outline" size="sm" onClick={run} disabled={active}>
      <RefreshCw className={cn("h-4 w-4", active && "animate-spin")} />
      {state === "idle" && "Sync now"}
      {state === "queued" && "Queued…"}
      {state === "running" && "Syncing…"}
      {state === "error" && "Retry sync"}
    </Button>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SiEntry {
  id: string;
  source: string;
  category: string | null;
  title: string | null;
  body: string | null;
  metrics: Record<string, number> | null;
  tags: string[];
  occurred_at: string;
}

interface SiImport {
  id: string;
  created_at: string;
  filename: string | null;
  format: string | null;
  row_count: number | null;
  status: string;
  error: string | null;
}

export default function SelfPage() {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<"feed" | "imports">("feed");
  const [entries, setEntries] = useState<SiEntry[]>([]);
  const [imports, setImports] = useState<SiImport[]>([]);
  const [tagFilter, setTagFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", category: "", tags: "" });

  const load = useCallback(async () => {
    let q = supabase
      .from("si_entries")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(100);
    if (tagFilter) q = q.contains("tags", [tagFilter]);
    const [{ data: e }, { data: im }] = await Promise.all([
      q,
      supabase.from("si_imports").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    setEntries((e ?? []) as SiEntry[]);
    setImports((im ?? []) as SiImport[]);
  }, [supabase, tagFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function addEntry() {
    if (!draft.title && !draft.body) return;
    await supabase.from("si_entries").insert({
      source: "manual",
      title: draft.title || null,
      body: draft.body || null,
      category: draft.category || null,
      tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
    });
    setDraft({ title: "", body: "", category: "", tags: "" });
    setShowAdd(false);
    load();
  }

  const allTags = [...new Set(entries.flatMap((e) => e.tags ?? []))];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Self Improvement</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Drop files into <code className="font-mono">si-inbox/</code>, POST to{" "}
            <code className="font-mono">/api/si/entries</code>, or quick-add here.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "Quick add"}
        </Button>
      </div>

      {showAdd && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <Input
              placeholder="title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="h-8 text-sm"
            />
            <textarea
              placeholder="body…"
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={3}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex gap-2">
              <Input
                placeholder="category"
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                className="h-8 w-40 text-sm"
              />
              <Input
                placeholder="tags, comma, separated"
                value={draft.tags}
                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                className="h-8 flex-1 text-sm"
              />
              <Button size="sm" onClick={addEntry}>Save</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-1 border-b">
        {(["feed", "imports"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "border-b-2 px-3 py-1.5 text-sm capitalize transition-colors",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t}
          </button>
        ))}
        {tab === "feed" && allTags.length > 0 && (
          <div className="ml-auto flex gap-1 pb-1">
            {allTags.slice(0, 8).map((t) => (
              <button
                key={t}
                onClick={() => setTagFilter(tagFilter === t ? "" : t)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-xs",
                  tagFilter === t
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === "feed" ? (
        <div className="space-y-2">
          {entries.map((e) => (
            <Card key={e.id}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  {e.title && <span className="text-sm font-medium">{e.title}</span>}
                  {e.category && <Badge variant="secondary">{e.category}</Badge>}
                  <Badge variant="outline">{e.source}</Badge>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {new Date(e.occurred_at).toLocaleString()}
                  </span>
                </div>
                {e.body && (
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
                    {e.body.length > 400 ? `${e.body.slice(0, 400)}…` : e.body}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {(e.tags ?? []).map((t) => (
                    <span key={t} className="text-xs text-primary">#{t}</span>
                  ))}
                  {e.metrics &&
                    Object.entries(e.metrics).map(([k, v]) => (
                      <span key={k} className="font-mono text-xs text-muted-foreground">
                        {k}={String(v)}
                      </span>
                    ))}
                </div>
              </CardContent>
            </Card>
          ))}
          {entries.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No entries yet. The SIE agent defines the taxonomy — this container
              stays deliberately loose.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 font-medium">Format</th>
                <th className="px-3 py-2 text-right font-medium">Rows</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {imports.map((im) => (
                <tr key={im.id}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                    {new Date(im.created_at).toLocaleString()}
                  </td>
                  <td className="max-w-56 truncate px-3 py-2">{im.filename}</td>
                  <td className="px-3 py-2 text-xs">{im.format}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{im.row_count}</td>
                  <td className="px-3 py-2">
                    <Badge variant={im.status === "done" ? "default" : "destructive"}>
                      {im.status}
                    </Badge>
                    {im.error && (
                      <span className="ml-2 text-xs text-destructive">{im.error}</span>
                    )}
                  </td>
                </tr>
              ))}
              {imports.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No imports yet — drop a JSON/CSV/MD file into si-inbox/.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

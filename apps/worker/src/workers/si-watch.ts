import { mkdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import chokidar from "chokidar";
import type { SupabaseClient } from "@supabase/supabase-js";

// Self Improvement drop-folder ingest (spec §5.10): JSON/CSV/MD/TXT files
// dropped into <repo>/si-inbox become si_entries rows; every batch is
// recorded in si_imports; processed files move to si-inbox/processed/.

type EntryDraft = {
  title: string | null;
  body: string | null;
  category: string | null;
  tags: string[];
  metrics: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  occurred_at: string;
};

function parseJson(content: string, fallbackDate: string): EntryDraft[] {
  const data = JSON.parse(content);
  const items = Array.isArray(data) ? data : Array.isArray(data.entries) ? data.entries : [data];
  return items.map((e: Record<string, unknown>) => ({
    title: (e.title as string) ?? null,
    body: (e.body as string) ?? (e.text as string) ?? null,
    category: (e.category as string) ?? null,
    tags: Array.isArray(e.tags) ? (e.tags as string[]) : [],
    metrics: (e.metrics as Record<string, unknown>) ?? null,
    payload: (e.payload as Record<string, unknown>) ?? null,
    occurred_at: (e.occurred_at as string) ?? (e.date as string) ?? fallbackDate,
  }));
}

function parseCsv(content: string, fallbackDate: string): EntryDraft[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    const metrics: Record<string, number> = {};
    for (const [k, v] of Object.entries(row)) {
      const n = Number(v);
      if (v !== "" && !Number.isNaN(n) && !["title", "body", "category", "tags", "date", "occurred_at"].includes(k)) {
        metrics[k] = n;
      }
    }
    return {
      title: row.title ?? null,
      body: row.body ?? null,
      category: row.category ?? null,
      tags: row.tags ? row.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
      metrics: Object.keys(metrics).length ? metrics : null,
      payload: null,
      occurred_at: row.occurred_at || row.date || fallbackDate,
    };
  });
}

function parseText(content: string, filename: string, fallbackDate: string): EntryDraft[] {
  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1];
  return [
    {
      title: firstHeading ?? basename(filename, extname(filename)),
      body: content,
      category: null,
      tags: [],
      metrics: null,
      payload: null,
      occurred_at: fallbackDate,
    },
  ];
}

async function ingestFile(db: SupabaseClient, path: string, processedDir: string) {
  const filename = basename(path);
  const ext = extname(filename).toLowerCase().replace(".", "");
  const format = ["json", "csv", "md", "txt"].includes(ext) ? ext : null;
  const now = new Date().toISOString();

  if (!format) {
    console.log(`[si] ignoring unsupported file: ${filename}`);
    return;
  }

  let entries: EntryDraft[] = [];
  let error: string | null = null;
  try {
    const content = readFileSync(path, "utf8");
    if (format === "json") entries = parseJson(content, now);
    else if (format === "csv") entries = parseCsv(content, now);
    else entries = parseText(content, filename, now);
  } catch (e: unknown) {
    error = (e as Error).message;
  }

  const { data: batch } = await db
    .from("si_imports")
    .insert({
      filename,
      source_path: path,
      format,
      row_count: entries.length,
      status: error ? "error" : "done",
      error,
    })
    .select("id")
    .single();

  if (!error && entries.length) {
    const rows = entries.map((e) => ({ ...e, source: "file_import" as const }));
    const { error: insErr } = await db.from("si_entries").insert(rows);
    if (insErr && batch) {
      await db.from("si_imports").update({ status: "error", error: insErr.message }).eq("id", batch.id);
    }
  }

  try {
    renameSync(path, join(processedDir, `${Date.now()}-${filename}`));
  } catch (e: unknown) {
    console.error(`[si] could not archive ${filename}:`, (e as Error).message);
  }
  console.log(`[si] ingested ${filename}: ${entries.length} entries${error ? ` (error: ${error})` : ""}`);
}

export function startSiWatcher(db: SupabaseClient, rootDir: string) {
  const inbox = join(rootDir, "si-inbox");
  const processedDir = join(inbox, "processed");
  mkdirSync(processedDir, { recursive: true });
  if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true });

  const watcher = chokidar.watch(inbox, {
    ignored: [processedDir, /(^|[/\\])\../],
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
  });
  watcher.on("add", (path) => {
    ingestFile(db, path, processedDir).catch((e) =>
      console.error("[si] ingest failed:", e.message)
    );
  });
  console.log(`[si] watching ${inbox}`);
}

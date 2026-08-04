import { NextResponse } from "next/server";
import { createClient as createSupabase } from "@supabase/supabase-js";

// Localhost programmatic ingest for the SIE agent (spec §5.10). The whole app
// is loopback-bound; this route additionally requires the SI_API_TOKEN bearer
// so only holders of the local token can write.
//
//   curl -X POST localhost:3141/api/si/entries \
//     -H "Authorization: Bearer $SI_API_TOKEN" -H "Content-Type: application/json" \
//     -d '{"title":"...","body":"...","tags":["focus"],"metrics":{"score":8}}'

export async function POST(request: Request) {
  const token = process.env.SI_API_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "bad json" }, { status: 400 });

  const items = Array.isArray(body) ? body : [body];
  const rows = items.map((e) => ({
    source: "api" as const,
    category: e.category ?? null,
    title: e.title ?? null,
    body: e.body ?? null,
    metrics: e.metrics ?? null,
    tags: Array.isArray(e.tags) ? e.tags : [],
    payload: e.payload ?? null,
    occurred_at: e.occurred_at ?? new Date().toISOString(),
  }));

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { error } = await db.from("si_entries").insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ inserted: rows.length });
}

/**
 * The browser's route to Supabase.
 *
 * This replaces a next.config rewrite. A rewrite forwards the request verbatim,
 * including the browser's Cookie header — and Supabase has no use for it. The
 * API authenticates with `apikey` and `Authorization: Bearer`; the session
 * cookie exists for this app's own server components and middleware.
 *
 * Forwarding it was actively harmful. Kong caps a single header line at 8KB,
 * and the auth cookie had grown past that: the gateway answered `Bad request`
 * in plain text, the Supabase client tried to parse it as JSON, and the failure
 * surfaced as "Unexpected token 'B'" on the two-factor screen — a broken login
 * with nothing in any log to explain it.
 *
 * The cookie grew because it used to be named after the URL it was served from,
 * so every address the app was opened at — localhost, a LAN IP, a Tailscale
 * address — left its own full session behind. The name is pinned now, but the
 * old ones are still in the browser, and nothing here can reach in and delete
 * them. Not sending them is the fix that does not depend on the browser being
 * tidy.
 */
import { type NextRequest, NextResponse } from "next/server";

const UPSTREAM = process.env.SUPABASE_INTERNAL_URL || "http://127.0.0.1:54321";

/**
 * Headers that must not be relayed.
 *
 * `cookie` is the point of this file. The rest are hop-by-hop or describe a
 * body that fetch re-encodes itself, and passing them on makes the upstream
 * disagree with what actually arrives.
 */
const STRIP = new Set([
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

async function proxy(request: NextRequest, path: string[]) {
  const url = new URL(`${UPSTREAM}/${path.join("/")}`);
  url.search = request.nextUrl.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase())) headers.set(key, value);
  });

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e: unknown) {
    // Answer in the shape the Supabase client expects. A plain-text body here
    // is what made the original failure so hard to read.
    return NextResponse.json(
      { error: "upstream_unreachable", message: (e as Error).message },
      { status: 502 }
    );
  }

  const out = new Headers(upstream.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");

  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}

type Ctx = { params: { path: string[] } };

export const GET = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const POST = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const PUT = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const PATCH = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const DELETE = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const HEAD = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const OPTIONS = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

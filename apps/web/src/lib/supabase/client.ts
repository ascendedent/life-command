import { createBrowserClient } from "@supabase/ssr";
import { AUTH_COOKIE_NAME } from "./cookie-name";

/**
 * The browser's Supabase URL, derived from where the page came from.
 *
 * Not the build-time `NEXT_PUBLIC_SUPABASE_URL`: that is `127.0.0.1:54321`,
 * which on any device other than this one points at that device. Requests go
 * through this app's `/supabase` proxy instead (see next.config.mjs), so the
 * origin the page was loaded from is always the right answer — localhost, a LAN
 * address, or a Tailscale name, with one build and no configuration.
 *
 * Server components and middleware keep using the direct address; they run on
 * the machine where 127.0.0.1 is true.
 */
function browserSupabaseUrl(): string {
  // During prerender there is no window. Nothing calls this then — it is the
  // browser client — but falling back keeps a stray import from throwing.
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_SUPABASE_URL!;
  }
  return `${window.location.origin}/supabase`;
}

export function createClient() {
  return createBrowserClient(
    browserSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Pinned, or the cookie name follows the URL and the server stops finding
    // the session the moment the app is opened from another address.
    { cookieOptions: { name: AUTH_COOKIE_NAME } }
  );
}

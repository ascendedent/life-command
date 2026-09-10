/**
 * One fixed name for the session cookie, everywhere.
 *
 * Supabase derives its cookie name from the Supabase URL — `sb-<first label of
 * the host>-auth-token`. That is invisible until the browser and the server
 * stop agreeing on the URL, which is exactly what happens once the app is
 * reachable from another device: the server talks to `127.0.0.1:54321` and
 * writes `sb-127-auth-token`, while a browser on the tailnet talks to
 * `100.111.113.43:3141` and writes `sb-100-auth-token`.
 *
 * Sign-in then succeeds — a real token is issued — and the very next request
 * carries a cookie the server does not look for, so it redirects back to the
 * login page. Nothing errors. The button simply stops and you are still on the
 * login screen, which reads as a wrong password.
 *
 * Pinning the name also makes sessions portable: the same login survives being
 * reached over localhost, the LAN, or a Tailscale address, because the cookie
 * no longer encodes which of those you came in by.
 */
export const AUTH_COOKIE_NAME = "sb-life-command-auth-token";

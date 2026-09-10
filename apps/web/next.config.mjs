/**
 * @type {import('next').NextConfig}
 *
 * The Supabase proxy is what makes this reachable from another device.
 *
 * `NEXT_PUBLIC_SUPABASE_URL` is compiled into the browser bundle, and on a
 * local install it is `http://127.0.0.1:54321`. Load the app from a phone and
 * that address means *the phone* — the page renders and then every login and
 * every query fails against a Supabase that isn't there.
 *
 * Rather than exposing Supabase on the network as well, the browser talks to it
 * through this app: one origin, one port, no CORS, and the database stack stays
 * bound to localhost where it was. The browser client builds its URL from
 * whatever origin the page was served from, so the same build works from
 * localhost, a LAN address, or a Tailscale name with nothing to reconfigure.
 */
const supabaseInternal = process.env.SUPABASE_INTERNAL_URL || "http://127.0.0.1:54321";

const nextConfig = {
  transpilePackages: ["@finance/shared"],
  async rewrites() {
    return [
      { source: "/supabase/:path*", destination: `${supabaseInternal}/:path*` },
    ];
  },
};

export default nextConfig;

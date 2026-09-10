// pm2-safe web launcher. The repo path contains a space, which breaks pm2's
// shell invocation of .bin shims — so launch Next's CLI in-process instead.
const path = require("node:path");

const root = path.join(__dirname, "..");
process.chdir(root);

// Read the root .env so the bind address can be changed without editing a
// systemd unit. Only WEB_HOST is taken from here; everything else the web app
// needs is already in apps/web/.env.local.
try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* dotenv missing: fall through to the loopback default below */
}

const bin = require.resolve("next/dist/bin/next", { paths: [root] });
process.argv = [
  process.argv[0],
  bin,
  "start",
  "apps/web",
  "-p",
  process.env.PORT || "3141",
  // Loopback by default (spec §2): nothing on the network reaches this app
  // unless the owner says so. `WEB_HOST=0.0.0.0` in the root .env opens it to
  // other devices — see the README's "Reaching it from a phone", which explains
  // why doing that over a plain LAN is not the recommended way.
  //
  // Supabase is deliberately not opened alongside it: the browser reaches the
  // database through this app's /supabase proxy, so this is the only port that
  // ever needs to listen anywhere.
  "-H",
  process.env.WEB_HOST || process.env.HOST || "127.0.0.1",
];
require(bin);

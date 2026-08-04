// pm2-safe web launcher. The repo path contains a space, which breaks pm2's
// shell invocation of .bin shims — so launch Next's CLI in-process instead.
const path = require("node:path");

const root = path.join(__dirname, "..");
process.chdir(root);

const bin = require.resolve("next/dist/bin/next", { paths: [root] });
process.argv = [
  process.argv[0],
  bin,
  "start",
  "apps/web",
  "-p",
  process.env.PORT || "3141",
  // Loopback only: nothing on the LAN should reach this app (spec §2).
  "-H",
  process.env.HOST || "127.0.0.1",
];
require(bin);

#!/usr/bin/env node
/**
 * Cross-platform service control.
 *
 * The application is portable already — Node, Next and the Supabase CLI run
 * the same on all three platforms, and nothing in `apps/` or `packages/`
 * assumes a POSIX path. What was not portable is the layer that keeps it
 * running: systemd user units, which exist only on Linux.
 *
 * This dispatches to whatever the host actually has — systemd on Linux,
 * launchd on macOS — and on Windows says plainly what to do instead rather
 * than failing with a confusing error about a missing command.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OS = platform();
const SERVICES = ["supabase", "web", "workers"];
const cmd = process.argv[2] ?? "status";

const run = (file, args, opts = {}) =>
  execFileSync(file, args, { stdio: "inherit", cwd: ROOT, ...opts });
const quiet = (file, args) => {
  try {
    return execFileSync(file, args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------- linux ----
const unit = (n) => `finance-${n}`;

function linux() {
  const units = SERVICES.map(unit);
  switch (cmd) {
    case "install":
      return run("bash", [join("scripts", "install-services.sh")]);
    case "start":
      return run("systemctl", ["--user", "start", ...units]);
    case "stop":
      return run("systemctl", ["--user", "stop", unit("web"), unit("workers")]);
    case "restart":
      return run("systemctl", ["--user", "restart", unit("web"), unit("workers")]);
    case "status":
      return run("systemctl", ["--user", "--no-pager", "status", ...units]);
    case "logs":
      return run("journalctl", ["--user", "-f", "-u", unit("web"), "-u", unit("workers")]);
    default:
      usage();
  }
}

// ---------------------------------------------------------------- macos ----
const LAUNCH_DIR = join(homedir(), "Library", "LaunchAgents");
const label = (n) => `com.lifecommand.${n}`;
const plistPath = (n) => join(LAUNCH_DIR, `${label(n)}.plist`);

function plist(name, program, args) {
  // KeepAlive restarts a crashed worker; RunAtLoad is the login autostart that
  // systemd gets from WantedBy=default.target.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(name)}</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
${[program, ...args].map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><${name === "supabase" ? "false" : "true"}/>
  <key>StandardOutPath</key><string>${join(ROOT, "logs", `${name}.log`)}</string>
  <key>StandardErrorPath</key><string>${join(ROOT, "logs", `${name}.err.log`)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}</string></dict>
</dict>
</plist>
`;
}

function macos() {
  const node = process.execPath;
  const npx = quiet("which", ["npx"]) || "/usr/local/bin/npx";
  const defs = {
    supabase: [npx, ["supabase", "start"]],
    web: [node, [join(ROOT, "scripts", "launch-web.js")]],
    workers: [node, [join(ROOT, "scripts", "launch-workers.js")]],
  };
  const loaded = (n) => quiet("launchctl", ["list", label(n)]) !== "";

  switch (cmd) {
    case "install": {
      mkdirSync(LAUNCH_DIR, { recursive: true });
      mkdirSync(join(ROOT, "logs"), { recursive: true });
      for (const n of SERVICES) {
        writeFileSync(plistPath(n), plist(n, ...defs[n]));
        if (loaded(n)) quiet("launchctl", ["unload", plistPath(n)]);
        run("launchctl", ["load", "-w", plistPath(n)]);
        console.log(`[install] loaded ${label(n)}`);
      }
      console.log("\nStart everything with: npm run svc:start");
      return;
    }
    case "start":
      for (const n of SERVICES) run("launchctl", ["start", label(n)]);
      return;
    case "stop":
      for (const n of ["web", "workers"]) run("launchctl", ["stop", label(n)]);
      return;
    case "restart":
      for (const n of ["web", "workers"]) {
        quiet("launchctl", ["stop", label(n)]);
        run("launchctl", ["start", label(n)]);
      }
      return;
    case "status":
      for (const n of SERVICES) {
        console.log(`${label(n)}: ${loaded(n) ? "loaded" : "not loaded"}`);
      }
      return;
    case "logs":
      return run("tail", ["-f", join(ROOT, "logs", "web.log"), join(ROOT, "logs", "workers.log")]);
    case "uninstall":
      for (const n of SERVICES) {
        if (loaded(n)) quiet("launchctl", ["unload", plistPath(n)]);
        if (existsSync(plistPath(n))) rmSync(plistPath(n));
      }
      return;
    default:
      usage();
  }
}

// -------------------------------------------------------------- windows ----
function windows() {
  if (cmd === "start" || cmd === "restart") return foreground();
  console.log(`
Windows has no supported autostart integration yet.

Run it in the foreground — this is fully functional, it simply does not
survive a reboot on its own:

    npm run up

To start it at login, create two Task Scheduler tasks set to "Run whether user
is logged on or not", with Start in set to this directory:

    node scripts\\launch-web.js
    node scripts\\launch-workers.js

Docker Desktop must be running first; set it to start at login in its own
settings. Then bring the database up with:

    npx supabase start
`);
}

// ------------------------------------------------------------ foreground ---
/** Runs everything in this terminal. Works identically on all three. */
function foreground() {
  console.log("[up] starting Supabase (Docker must already be running)…");
  try {
    run("npx", ["supabase", "start"], { stdio: "inherit", shell: OS === "win32" });
  } catch {
    console.log("[up] supabase start reported it is already running — continuing");
  }
  run(process.execPath, [join(ROOT, "scripts", "sync-env.mjs")]);
  for (const s of ["launch-web.js", "launch-workers.js"]) {
    const child = spawn(process.execPath, [join(ROOT, "scripts", s)], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) => console.log(`[up] ${s} exited (${code})`));
  }
  console.log("[up] web on http://localhost:3141 — Ctrl-C to stop");
}

function usage() {
  console.log("usage: node scripts/svc.mjs <install|start|stop|restart|status|logs|up>");
  process.exit(1);
}

if (cmd === "up") foreground();
else if (OS === "linux") linux();
else if (OS === "darwin") macos();
else if (OS === "win32") windows();
else {
  console.log(`Unsupported platform "${OS}". Try: npm run up`);
  process.exit(1);
}

#!/usr/bin/env node
// Creates (or repairs) the single allow-listed owner account.
//
//   OWNER_EMAIL=you@example.com OWNER_PASSWORD='...' node scripts/create-owner.mjs
//
// If OWNER_PASSWORD is omitted a strong random one is generated and printed —
// change it after first login. Signup is disabled in supabase/config.toml, so
// this admin script is the only way accounts get created.

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(root, ".env") });

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.OWNER_EMAIL;
let password = process.env.OWNER_PASSWORD;

if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — run `npm run env:sync` first.");
  process.exit(1);
}
if (!email) {
  console.error("Set OWNER_EMAIL=you@example.com");
  process.exit(1);
}

let generated = false;
if (!password) {
  password = randomBytes(18).toString("base64url");
  generated = true;
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Find existing user (idempotent re-runs) or create one.
const { data: list, error: listError } = await db.auth.admin.listUsers();
if (listError) {
  console.error("listUsers failed:", listError.message);
  process.exit(1);
}
let user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

if (user) {
  console.log(`User ${email} already exists (${user.id})`);
  if (process.env.OWNER_PASSWORD) {
    const { error } = await db.auth.admin.updateUserById(user.id, { password });
    if (error) {
      console.error("password update failed:", error.message);
      process.exit(1);
    }
    console.log("Password updated.");
  }
} else {
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    console.error("createUser failed:", error.message);
    process.exit(1);
  }
  user = data.user;
  console.log(`Created user ${email} (${user.id})`);
  if (generated) {
    console.log(`Generated password: ${password}`);
    console.log("Change it after first login.");
  }
}

// Allow-list as the app owner (RLS lets only this user through).
const { error: ownerError } = await db
  .from("app_owner")
  .upsert({ user_id: user.id }, { onConflict: "user_id" });
if (ownerError) {
  console.error("app_owner upsert failed:", ownerError.message);
  process.exit(1);
}
console.log("Owner allow-listed in app_owner. TOTP enrollment happens on first login.");

await db.from("audit_log").insert({
  actor: "system",
  action: "owner_created",
  entity: "app_owner",
  entity_id: user.id,
  detail: { email },
});

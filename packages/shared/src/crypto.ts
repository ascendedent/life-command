import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM application-layer encryption for Plaid access tokens (security
// policy §6: tokens are never stored in plaintext). Key: APP_ENCRYPTION_KEY,
// 64 hex chars (32 bytes), generated at setup and kept in gitignored .env.

function key(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("APP_ENCRYPTION_KEY missing or not 64 hex chars");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("v1:")) throw new Error("unknown ciphertext version");
  const raw = Buffer.from(stored.slice(3), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

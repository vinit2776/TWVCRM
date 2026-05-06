/**
 * Server-side cache for IRP auth tokens + SEK.
 *
 * Why cache:
 *   - Tokens last 6 hrs in production / 1 hr in sandbox
 *   - Re-authenticating before expiry returns the same token (NIC won't reset)
 *   - Auth involves a network round-trip + crypto handshake (~200ms)
 *   - Concurrent requests would otherwise each trigger a fresh auth call
 *
 * Storage: rows in `app_settings` table (we already seeded the keys in
 * migration 00126):
 *   einvoice_cached_auth_token        (encrypted at rest by app layer)
 *   einvoice_cached_sek               (encrypted at rest by app layer)
 *   einvoice_cached_token_expires_at  (ISO string)
 *
 * The application-level encryption uses a server-only secret from env var
 * `EINVOICE_SECRETS_KEY` (32 bytes hex). We never store plaintext SEK.
 *
 * NOTE: This cache is read-mostly. Concurrent writes are extremely rare
 * (only at the moment of token expiry); we handle them with a simple
 * "if-it-changed-while-we-were-fetching, prefer the fresh row" pattern.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ─── Local-secret encryption (separate from IRP's SEK) ───────────────────────
//
// The local secret protects credentials/tokens at rest in `app_settings`. It
// is independent from the IRP's RSA / SEK ceremony. Format: AES-256-GCM with
// a 12-byte IV prepended to the ciphertext. Tag is appended.

const LOCAL_KEY_HEX = process.env.EINVOICE_SECRETS_KEY;

/** Derive 32-byte key from env var; throws if not configured. */
function localKey(): Buffer {
  if (!LOCAL_KEY_HEX) {
    throw new Error(
      "EINVOICE_SECRETS_KEY env var is not set. Generate one with: " +
      "`openssl rand -hex 32` and add to .env.local / production secrets."
    );
  }
  if (LOCAL_KEY_HEX.length !== 64) {
    throw new Error(`EINVOICE_SECRETS_KEY must be 64 hex chars (32 bytes). Got ${LOCAL_KEY_HEX.length}.`);
  }
  return Buffer.from(LOCAL_KEY_HEX, "hex");
}

/** Encrypt a plaintext string with the local secret. Output: base64(iv||ciphertext||tag) */
export function encryptAtRest(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

/** Decrypt a value previously produced by encryptAtRest(). */
export function decryptAtRest(ciphertextBase64: string): string {
  const buf = Buffer.from(ciphertextBase64, "base64");
  if (buf.length < 12 + 16) {
    throw new Error("decryptAtRest: ciphertext too short");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", localKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

// ─── Cache shape ────────────────────────────────────────────────────────────

export interface CachedSession {
  authToken: string;
  sek: Buffer;
  expiresAt: Date;       // when the token expires (from IRP)
  cachedAt: Date;        // when we wrote the row
}

const SETTING_KEYS = {
  authToken: "einvoice_cached_auth_token",
  sek: "einvoice_cached_sek",
  expiresAt: "einvoice_cached_token_expires_at",
  lastAuthAt: "einvoice_last_successful_auth_at",
} as const;

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Load the cached session from `app_settings`. Returns null if missing,
 * malformed, or expired (with a 10-minute safety margin per NIC's
 * ForceRefreshAccessToken convention).
 */
export async function loadSession(supabase: SupabaseClient): Promise<CachedSession | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [SETTING_KEYS.authToken, SETTING_KEYS.sek, SETTING_KEYS.expiresAt]);

  if (error || !data || data.length < 3) return null;

  const map = new Map<string, string>(data.map((r) => [r.key, r.value]));
  const tokenEnc = map.get(SETTING_KEYS.authToken);
  const sekEnc = map.get(SETTING_KEYS.sek);
  const expiresStr = map.get(SETTING_KEYS.expiresAt);

  if (!tokenEnc || !sekEnc || !expiresStr) return null;

  const expiresAt = new Date(expiresStr);
  if (isNaN(expiresAt.getTime())) return null;

  // 10-minute safety margin: refresh if within 10 minutes of expiry
  const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000);
  if (expiresAt < tenMinutesFromNow) return null;

  try {
    const authToken = decryptAtRest(tokenEnc);
    const sekBase64 = decryptAtRest(sekEnc);
    return {
      authToken,
      sek: Buffer.from(sekBase64, "base64"),
      expiresAt,
      cachedAt: new Date(),
    };
  } catch {
    // Corrupt cache (key rotation?) — force re-auth
    return null;
  }
}

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Persist a fresh session to `app_settings`. Encrypts token + SEK at rest.
 * Updates the "last successful auth" timestamp for ops visibility.
 */
export async function saveSession(
  supabase: SupabaseClient,
  session: { authToken: string; sek: Buffer; expiresAt: Date }
): Promise<void> {
  const upserts = [
    { key: SETTING_KEYS.authToken, value: encryptAtRest(session.authToken), is_encrypted: true },
    { key: SETTING_KEYS.sek, value: encryptAtRest(session.sek.toString("base64")), is_encrypted: true },
    { key: SETTING_KEYS.expiresAt, value: session.expiresAt.toISOString(), is_encrypted: false },
    { key: SETTING_KEYS.lastAuthAt, value: new Date().toISOString(), is_encrypted: false },
  ];

  for (const row of upserts) {
    await supabase
      .from("app_settings")
      .upsert(row, { onConflict: "key" });
  }
}

/** Clear the cache (used after a failed call where we suspect token is bad). */
export async function clearSession(supabase: SupabaseClient): Promise<void> {
  await supabase
    .from("app_settings")
    .update({ value: "" })
    .in("key", [SETTING_KEYS.authToken, SETTING_KEYS.sek, SETTING_KEYS.expiresAt]);
}

/**
 * AES-256-GCM encrypt/decrypt for secrets we store at rest (currently: IT
 * asset admin passwords in `facility_asset_credentials`). GCM gives us a
 * random IV per value plus an auth tag, unlike the ECB mode in
 * `src/lib/e-invoice/crypto.ts` (which NIC's protocol mandates and which is
 * explicitly weaker) -- this is for our own storage, so we don't inherit
 * that constraint.
 *
 * Output format: base64(iv[12] + authTag[16] + ciphertext) as a single
 * string column, so callers don't need to manage multiple fields.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.ASSET_CREDENTIALS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ASSET_CREDENTIALS_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes) -- generate one with `openssl rand -hex 32`."
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const key = getKey();
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Crypto utilities for the NIC e-invoice protocol (also used by IRIS, since
 * IRIS replicates NIC's API protocol identically).
 *
 * Two algorithms in play:
 *
 *   1. RSA / ECB / PKCS1Padding — used at AUTHENTICATION time only.
 *      We RSA-encrypt our password and our 32-byte AppKey using the IRP's
 *      published public key, send the ciphertext, and the IRP returns the
 *      AuthToken + an AES-encrypted SEK (Session Encryption Key) which is
 *      decrypted using our AppKey.
 *
 *   2. AES-256 / ECB / PKCS7Padding — used for ALL request payloads after
 *      authentication. Every request body to /eicore/v1.03/* is the JSON
 *      payload encrypted with the SEK. Every response body is encrypted
 *      with the same SEK and must be decrypted before parsing.
 *
 * Spec source: NIC e-Invoice API Sandbox docs
 *   https://einv-apisandbox.nic.in/version1.03/authentication.html
 *
 * NOTE on ECB mode: ECB is generally considered weak (no IV, identical
 * plaintexts → identical ciphertexts). NIC mandates it; we have no choice.
 * Mitigation: payloads are JSON with timestamps and IRNs that change per
 * request, so the practical risk is low.
 */

import {
  publicEncrypt,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  constants,
} from "crypto";

// ─── 1. AppKey generation ────────────────────────────────────────────────────

/**
 * Generate a fresh 32-byte (256-bit) AppKey for a new auth session.
 * NIC requires the AppKey to be 32 bytes — that becomes the AES key the
 * IRP uses to wrap the SEK in the auth response.
 */
export function generateAppKey(): Buffer {
  return randomBytes(32);
}

// ─── 2. RSA encryption (auth time) ───────────────────────────────────────────

/**
 * RSA-encrypt the given plaintext with the IRP's public key (PEM format).
 *
 * NIC mandates RSA/ECB/PKCS1Padding — Node's `publicEncrypt` with
 * RSA_PKCS1_PADDING produces exactly this.
 *
 * Returns the ciphertext as a Base64 string (NIC payload format).
 */
export function rsaEncryptToBase64(publicKeyPem: string, plaintext: Buffer | string): string {
  const buf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const cipher = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING },
    buf
  );
  return cipher.toString("base64");
}

// ─── 3. AES-256-ECB encryption (after auth) ──────────────────────────────────

/**
 * AES-256-ECB-PKCS7 encrypt a UTF-8 string with the given key (Buffer).
 * Returns Base64 ciphertext (NIC payload format).
 *
 * The Node 'aes-256-ecb' cipher uses no IV (ECB has no IV) but
 * createCipheriv requires us to pass null. PKCS#7 padding is the default
 * Node padding scheme when autoPadding is true (which it is by default).
 */
export function aesEcbEncryptToBase64(key: Buffer, plaintext: string): string {
  if (key.length !== 32) {
    throw new Error(`aesEcbEncryptToBase64: key must be 32 bytes, got ${key.length}`);
  }
  const cipher = createCipheriv("aes-256-ecb", key, null);
  // autoPadding = true → PKCS7 (which equals PKCS5 for AES block size)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return enc.toString("base64");
}

/**
 * AES-256-ECB-PKCS7 decrypt a Base64 ciphertext with the given key.
 * Returns the plaintext UTF-8 string.
 */
export function aesEcbDecryptFromBase64(key: Buffer, ciphertextBase64: string): string {
  if (key.length !== 32) {
    throw new Error(`aesEcbDecryptFromBase64: key must be 32 bytes, got ${key.length}`);
  }
  const decipher = createDecipheriv("aes-256-ecb", key, null);
  const enc = Buffer.from(ciphertextBase64, "base64");
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

// ─── 4. Convenience: SEK decryption ──────────────────────────────────────────

/**
 * Decrypt the SEK returned by the IRP at auth time.
 *
 * The IRP returns the SEK as Base64-encoded ciphertext that's been encrypted
 * with our AppKey using AES-256-ECB-PKCS7. We decrypt it back to a 32-byte
 * Buffer which is then used to encrypt all subsequent request payloads.
 *
 * The returned Base64 *plaintext* (yes — the decrypted form is itself Base64
 * because that's how NIC wraps the raw SEK bytes) is converted to a Buffer.
 */
export function decryptSek(appKey: Buffer, sekBase64FromIrp: string): Buffer {
  const decryptedBase64 = aesEcbDecryptFromBase64(appKey, sekBase64FromIrp);
  return Buffer.from(decryptedBase64, "base64");
}

/**
 * Symmetric helper: encrypt a payload that's about to be sent to the IRP.
 * Wraps the plaintext JSON in `{ "Data": "<base64-of-aes-ecb-encrypted-json>" }`.
 */
export function encryptIrpRequestBody(sek: Buffer, jsonPayload: object): string {
  return aesEcbEncryptToBase64(sek, JSON.stringify(jsonPayload));
}

/**
 * Symmetric helper: decrypt a response body that came from the IRP.
 * IRP responses encrypt the inner Data field with the SEK; we decrypt and
 * parse as JSON.
 */
export function decryptIrpResponseData<T = unknown>(sek: Buffer, base64Ciphertext: string): T {
  const json = aesEcbDecryptFromBase64(sek, base64Ciphertext);
  return JSON.parse(json) as T;
}

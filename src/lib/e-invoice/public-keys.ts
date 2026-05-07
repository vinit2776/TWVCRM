/**
 * IRP RSA public keys (PEM format).
 *
 * These keys are PUBLIC by design — they're shared with every API consumer
 * who registers with the respective IRP. They are not secrets; embedding
 * them in source is correct and matches NIC/IRIS guidance.
 *
 * Security model:
 *   - Public key encrypts our password + AppKey at auth time
 *   - Only the IRP's private key can decrypt — so even if intercepted,
 *     ciphertext is useless without the IRP-side private key
 *
 * To rotate (when an IRP rotates their key):
 *   1. Download the new PEM from the IRP's developer portal
 *   2. Replace the constant below
 *   3. Deploy
 *   4. Existing AuthTokens (cached) keep working until expiry; the new
 *      key is only consulted on the next fresh authentication.
 */

/**
 * IRIS IRP6 — SANDBOX public key.
 * Source: IRIS developer onboarding (sandbox download — May 2026).
 * Domain: api.sandbox.core.irisirp.com
 */
export const IRIS_SANDBOX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICnzANBgkqhkiG9w0BAQEFAAOCAowAMIIChwKCAn4AqxkXZ2PKnqiCzObw9jyb0M1fMBhnbc/WcFilZ9IEM5Ku50rOF7/6s8kl240+qUGylwbMWvxDsXfnixiMoczm65p5clh9NtrJvlpMV7jZSQLPWxRFDXxlxhUhxcvaE7FjA83KWQvzKDunZztxIr5esFrAaCdMqawjoXMBkqpw/EYLZl3Y0eIcWWHzhWIWj74XdC57XCb3RWovcLCUf4+nkJgmGTSAnencVrokvPqWM9Sy5GfI95ahDXIgLsvhlIhenY9ZJGEAJbmJ7eotPfRduzBI+eu9J/RqRnXrmvixvvxuniDlnQK+CdUp+qoTvnhghyRvG9sieJfIN7986BPwhxXUCcuv4qOCSjJSUgWr+W9fNZ7R6ryqSFTmfqXSDPSwZYX3XsTBqzHaPS13cTk/4S+2hrE4g5Fg+rHrOCOadVwANBo4zSLyfjmKvy+zhXYHurOoDxIqeEa/ASqWmqu1H57k9uxji5qdKTZQWDdIDJjPKeQI+6pRShNOqKCyuKNnj1UE3viaaTg1TMvHtvER31+NKlORl0q3sPnRI+wJNl95rXiBIzs8F+DQr6JI2Vc6cSESToRBqdbY+ut4HFRJdQw1Ctc1tjNpd3Ly2M7bcKGl2EegpAl4TFS28zJd7zcWUec/okJKT0SPtsKkSSvhW3w4usC66CX5xWJH0EiF7aO76hw1zwVcvW/1Ug1FGd65Yp/q7SLFu1RoBCE/ctGZQQzFl3btmOgPM6de7UG1OxLd966j1iKVHGD4pCtTIJj/sJTYF46SapMh+4EAAkhy71LYZEqpa4ljRF84ao6uIOMZ5rdNLmF/H02tl/mCjbv2scsil4xez1klBK69HQIDAQAB
-----END PUBLIC KEY-----`;

/**
 * IRIS IRP6 — PRODUCTION public key.
 * To be added when production credentials are issued.
 * Domain: api.einvoice6.gst.gov.in
 */
export const IRIS_PRODUCTION_PUBLIC_KEY = "";  // TODO: download from IRIS production portal before go-live

/**
 * NIC IRP-1 / IRP-2 — SANDBOX public key.
 * Source: https://einv-apisandbox.nic.in (PublicKey download under API
 * Specifications). Same key used by both NIC1 and NIC2 in sandbox.
 */
export const NIC_SANDBOX_PUBLIC_KEY = "";  // populate if/when we build NIC-direct path

/**
 * NIC IRP-1 / IRP-2 — PRODUCTION public key.
 */
export const NIC_PRODUCTION_PUBLIC_KEY = "";

/**
 * Lookup helper — returns the right embedded key for a given provider/env.
 * Returns null if the key isn't configured yet (caller decides what to do).
 */
export function lookupPublicKey(provider: string, environment: string): string | null {
  if (provider === "einvoice6" || provider === "iris") {
    if (environment === "sandbox") return IRIS_SANDBOX_PUBLIC_KEY;
    if (environment === "production") return IRIS_PRODUCTION_PUBLIC_KEY || null;
  }
  if (provider === "nic1" || provider === "nic2") {
    if (environment === "sandbox") return NIC_SANDBOX_PUBLIC_KEY || null;
    if (environment === "production") return NIC_PRODUCTION_PUBLIC_KEY || null;
  }
  return null;
}

import { createHmac, timingSafeEqual } from "crypto";

// A review token proves a clause text came out of the AI draft-and-verify
// pipeline unmodified, so the server never has to trust the client's claim that
// "Claude reviewed this". Signed with the service key (server-only), so no new
// env var is needed.

const TTL_MS = 60 * 60 * 1000;

function secret(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return key;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

function payloadFor(clauseText: string, intent: string, issuedAt: number): string {
  return `${issuedAt}.${createHmac("sha256", "sc").update(`${intent}\n${clauseText}`).digest("hex")}`;
}

export function issueReviewToken(clauseText: string, intent: string, now = Date.now()): string {
  const payload = payloadFor(clauseText, intent, now);
  return `${payload}.${sign(payload)}`;
}

export function verifyReviewToken(
  token: string | undefined | null,
  clauseText: string,
  intent: string,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const issuedAt = Number(parts[0]);
  if (!Number.isFinite(issuedAt) || now - issuedAt > TTL_MS || issuedAt > now + 60_000) return false;
  const expected = `${sign(payloadFor(clauseText, intent, issuedAt))}`;
  const given = Buffer.from(parts[2]);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

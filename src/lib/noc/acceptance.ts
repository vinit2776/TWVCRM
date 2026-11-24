// Pure rules for the customer's side of a NOC: what they must accept, how they are tied to a named person, and the
// one-time code that proves they hold the contact details on the contract. No I/O. The hash itself and the code
// generation live in server.ts (they need node:crypto); everything decidable lives here so it can be tested.

import { NOC_CLAUSES, NOC_TEXT_VERSION, PURPOSE_LABELS, type NocPurpose } from "@/lib/noc/rules";

/** The fourth tick: the commercial terms, which are not printed in the certificate itself. */
export const serviceTerms = (validUntilLabel: string) =>
  `The NOC is issued after the full fee is received, is valid only until this agreement ends (${validUntilLabel} at the latest), needs a new paid NOC on a renewal or a new agreement, and the fee is not refundable once the NOC is issued.`;

/** Number of boxes the customer must tick: the three printed paragraphs plus the service terms. */
export const REQUIRED_TICKS = NOC_CLAUSES.length + 1;

export interface AcceptedWords {
  purpose: NocPurpose;
  company: string;
  centre: string;
  address: string;
  feeTotal: number;
  validUntil: string;
  agreementDate: string | null;
}

/**
 * The exact words and particulars the customer saw, as one canonical string. Its hash is stored with the acceptance,
 * so what was accepted can be proved byte for byte later even if the template or fee changes.
 */
export function acceptedWordsCanonical(w: AcceptedWords): string {
  return [
    NOC_TEXT_VERSION, PURPOSE_LABELS[w.purpose], w.company, w.centre, w.address, `fee:${w.feeTotal}`, `valid:${w.validUntil}`,
    `agreement:${w.agreementDate ?? ""}`, ...NOC_CLAUSES, serviceTerms(w.validUntil),
  ].join("\n--\n");
}

// ── Who is accepting ─────────────────────────────────────────────────────────────────────────────────────────
export type SignatoryMatch = "matches" | "partial" | "mismatch" | "no_record";

const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "shri", "smt", "sri", "mohd", "md"]);
const nameTokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !TITLES.has(t));

/**
 * Compares the name the customer typed with the signatory recorded on the agreement. A match is shown on the
 * acceptance certificate; a mismatch never stops the order but is flagged to staff before the NOC is issued.
 */
export function matchSignatory(typed: string, recorded: string | null | undefined): SignatoryMatch {
  const r = nameTokens(recorded ?? "");
  if (r.length === 0) return "no_record";
  const t = nameTokens(typed);
  if (t.length === 0) return "mismatch";
  const hits = r.filter((x) => t.includes(x)).length;
  if (hits === r.length || hits === t.length) return "matches";
  return hits > 0 ? "partial" : "mismatch";
}

export interface AcceptanceInput { name?: string; designation?: string; ticks?: boolean[]; code?: string }

export function validateAcceptance(i: AcceptanceInput): string[] {
  const errors: string[] = [];
  if (!i.name?.trim() || i.name.trim().length < 3) errors.push("Enter your full name.");
  if (!i.designation?.trim()) errors.push("Enter your designation in the company.");
  if (!i.ticks || i.ticks.length !== REQUIRED_TICKS || !i.ticks.every(Boolean)) errors.push("Tick every box to confirm you have read each paragraph.");
  if (!/^\d{6}$/.test((i.code ?? "").trim())) errors.push("Enter the 6-digit code we emailed you.");
  return errors;
}

// ── One-time code ────────────────────────────────────────────────────────────────────────────────────────────
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_MINUTES = 10;

/** May another code be sent? At most OTP_MAX_SENDS in the window, so the link cannot be used to flood a mailbox. */
export function otpSendDecision(sentAt: string[], nowMs: number): { ok: true } | { ok: false; error: string } {
  const windowStart = nowMs - OTP_SEND_WINDOW_MINUTES * 60_000;
  const recent = sentAt.filter((t) => new Date(t).getTime() >= windowStart).length;
  return recent >= OTP_MAX_SENDS
    ? { ok: false, error: `A code was sent ${OTP_MAX_SENDS} times in the last ${OTP_SEND_WINDOW_MINUTES} minutes. Use the latest one, or try again shortly.` }
    : { ok: true };
}

export interface OtpRow { code_hash: string; attempts: number; expires_at: string; verified_at: string | null }

/** Decides whether an entered code is accepted. The caller supplies the hash of what was typed. */
export function otpVerifyDecision(row: OtpRow | null, enteredHash: string, nowMs: number):
  | { ok: true } | { ok: false; reason: "none" | "expired" | "locked" | "wrong"; error: string } {
  if (!row) return { ok: false, reason: "none", error: "Ask for a code first." };
  if (new Date(row.expires_at).getTime() < nowMs) return { ok: false, reason: "expired", error: "That code has expired. Ask for a new one." };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "locked", error: "Too many wrong tries. Ask for a new code." };
  if (row.code_hash !== enteredHash) return { ok: false, reason: "wrong", error: "That code is not right." };
  return { ok: true };
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "your email";
  return `${user.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(4, user.length - 1)))}@${domain}`;
}

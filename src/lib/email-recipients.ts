/**
 * Pure helpers for the To and CC a staff member can set when emailing a
 * customer from a booking. Shared by the dialogs (to enable Send) and the
 * routes (to validate), so the two can never disagree about what is valid.
 */

export const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export const MAX_CC = 10;

/** Splits "a@x.com, b@y.com; c@z.com" into addresses, separating out any that don't look valid. */
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (!EMAIL_PATTERN.test(p)) { invalid.push(p); continue; }
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(p);
  }
  return { emails, invalid };
}

export type RecipientsResult =
  | { ok: true; to: string | null; cc: string[] }
  | { ok: false; error: string };

/**
 * `to` replaces the saved address when given; `cc` is a list or free text. The
 * primary is never repeated in CC, and CC is capped so one click cannot mail a crowd.
 */
export function validateRecipients(input: { to?: unknown; cc?: unknown }): RecipientsResult {
  const toText = typeof input.to === "string" ? input.to.trim() : "";
  if (toText && !EMAIL_PATTERN.test(toText)) {
    return { ok: false, error: `"${toText}" doesn't look like an email address.` };
  }
  const ccText = Array.isArray(input.cc)
    ? input.cc.filter((c): c is string => typeof c === "string").join(",")
    : typeof input.cc === "string" ? input.cc : "";
  const { emails, invalid } = parseEmailList(ccText);
  if (invalid.length > 0) {
    return { ok: false, error: `CC has an address that doesn't look right: ${invalid[0]}` };
  }
  const cc = emails.filter((e) => e.toLowerCase() !== toText.toLowerCase());
  if (cc.length > MAX_CC) {
    return { ok: false, error: `CC at most ${MAX_CC} addresses.` };
  }
  return { ok: true, to: toText || null, cc };
}

/**
 * Roles that send customer emails from a booking. Only these may point one at a
 * different address or add CCs, so the company's sender cannot be used by any
 * login to mail arbitrary people.
 */
export const CUSTOMER_EMAIL_ROLES = [
  "admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin", "coordinator",
] as const;

export function canChooseRecipients(role: string | null | undefined): boolean {
  return !!role && (CUSTOMER_EMAIL_ROLES as readonly string[]).includes(role);
}

/**
 * Who is copied on a Virtual Office renewal notice, besides the billing party.
 *
 * Staff-facing only: the sales owner hears what their customer was sent, and
 * from the 4th reminder on accounts is copied too. Pure, so the cron and
 * Start renewal share one rule.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const RENEWAL_ACCOUNTS_EMAIL = "accounts@theworkvilla.com";
/** Accounts is copied from this reminder number on (4 is the last one before the end date; 5 is the final notice). */
export const ACCOUNTS_COPY_FROM_REMINDER = 4;

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function cleanEmail(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
}

export function renewalCopies(params: {
  reminderNumber: number;
  ownerEmail: string | null | undefined;
  /** Addresses already on the message (To, or cc added by a person); never repeated. */
  alreadyAddressed?: Array<string | null | undefined>;
}): string[] {
  const taken = new Set((params.alreadyAddressed ?? []).map(cleanEmail).filter((e): e is string => !!e));
  const out: string[] = [];
  const add = (email: string | null) => {
    if (email && !taken.has(email)) {
      taken.add(email);
      out.push(email);
    }
  };
  add(cleanEmail(params.ownerEmail));
  if (params.reminderNumber >= ACCOUNTS_COPY_FROM_REMINDER) add(RENEWAL_ACCOUNTS_EMAIL);
  return out;
}

/** The email of the user a case is assigned to, or null when there is none. */
export async function caseOwnerEmail(
  admin: SupabaseClient,
  assignedTo: string | null | undefined,
): Promise<string | null> {
  if (!assignedTo) return null;
  const { data } = await admin.from("users").select("email").eq("id", assignedTo).maybeSingle();
  return cleanEmail((data as { email?: string | null } | null)?.email);
}

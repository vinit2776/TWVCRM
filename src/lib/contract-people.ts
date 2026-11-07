/**
 * Contract people & access.
 *
 * A "person" on a contract is a `contract_contacts` row. When that person is
 * meant to use the space they also have a `contract_members` row (linked
 * through `contract_contacts.source_member_id`), and a member occupies a seat.
 * WiFi vouchers and door access hang off the member.
 *
 * Adding a person never issues anything. Issuing a voucher or door access is a
 * separate step, normally done by IT, so a person can be recorded by sales
 * before access exists. `computeAccessSetup` turns the current state into the
 * "what is still pending, and whose turn is it" view the contract page shows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const PERSON_ROLES = [
  "occupant",
  "finance",
  "signatory",
  "primary",
  "escalation",
  "it",
  "general",
] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

/** Roles that get access by default when added. Everyone else starts as contact-only. */
export const DEFAULT_ACCESS_ROLES: readonly PersonRole[] = ["occupant"];

export function phoneDigits(phone?: string | null): string {
  return (phone ?? "").replace(/\D/g, "").slice(-10);
}

export function normalizeEmail(email?: string | null): string {
  return (email ?? "").trim().toLowerCase();
}

/** Two people are the same if they share a 10-digit phone or an email. */
export function isSamePerson(
  a: { phone?: string | null; email?: string | null },
  b: { phone?: string | null; email?: string | null }
): boolean {
  const pa = phoneDigits(a.phone);
  if (pa.length === 10 && pa === phoneDigits(b.phone)) return true;
  const ea = normalizeEmail(a.email);
  return !!ea && ea === normalizeEmail(b.email);
}

// ─── Setup state ─────────────────────────────────────────────────────────────

export interface PersonAccessRow {
  contactId: string;
  memberId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  needsVoucher: boolean;
  needsDoor: boolean;
  voucherIssued: boolean;
  doorEnrolled: boolean;
}

export type SetupState = "complete" | "pending" | "needs_review";
export type WaitingOn = "it" | "sales" | null;

export interface PersonSetup {
  voucherPending: boolean;
  doorPending: boolean;
  /** Who has to act next for this person; null when nothing is pending. */
  waitingOn: WaitingOn;
  /** Why sales has to act (only set when waitingOn is "sales"). */
  salesReason: "email_needed" | null;
}

export interface AccessSetup {
  state: SetupState;
  seats: number;
  seatsUsed: number;
  seatsOpen: number;
  vouchersPending: number;
  doorPending: number;
  waitingOn: WaitingOn;
  byContact: Record<string, PersonSetup>;
}

/**
 * Open seats never make a contract incomplete: a customer can pay for 5 seats
 * and have 3 people so far. Only people already named count. "needs_review" is
 * reserved for a contract with paid seats and nobody recorded at all, where the
 * CRM cannot tell whether access was set up offline or not at all.
 */
export function computeAccessSetup(rows: PersonAccessRow[], seats: number): AccessSetup {
  const members = rows.filter((r) => r.memberId && r.isActive);
  const byContact: Record<string, PersonSetup> = {};
  let vouchersPending = 0;
  let doorPending = 0;
  let anyIt = false;
  let anySales = false;

  for (const m of members) {
    const voucherPending = m.needsVoucher && !m.voucherIssued;
    const doorPendingHere = m.needsDoor && !m.doorEnrolled;
    if (voucherPending) vouchersPending += 1;
    if (doorPendingHere) doorPending += 1;

    let waitingOn: WaitingOn = null;
    let salesReason: PersonSetup["salesReason"] = null;
    if (voucherPending || doorPendingHere) {
      // A voucher is emailed, so it cannot be issued without an address. If that
      // is the only thing pending, IT cannot move and sales has to fill it in.
      if (voucherPending && !m.email && !doorPendingHere) {
        waitingOn = "sales";
        salesReason = "email_needed";
      } else {
        waitingOn = "it";
      }
    }
    if (waitingOn === "it") anyIt = true;
    if (waitingOn === "sales") anySales = true;
    byContact[m.contactId] = { voucherPending, doorPending: doorPendingHere, waitingOn, salesReason };
  }

  const seatsUsed = members.length;
  let state: SetupState;
  if (seats > 0 && seatsUsed === 0) state = "needs_review";
  else if (vouchersPending + doorPending > 0) state = "pending";
  else state = "complete";

  return {
    state,
    seats,
    seatsUsed,
    seatsOpen: Math.max(0, seats - seatsUsed),
    vouchersPending,
    doorPending,
    waitingOn: anyIt ? "it" : anySales ? "sales" : null,
    byContact,
  };
}

// ─── Adding a person ─────────────────────────────────────────────────────────

export interface AddPersonInput {
  contractId: string;
  name: string;
  role: PersonRole;
  email?: string | null;
  phone?: string | null;
  needsVoucher: boolean;
  needsDoor: boolean;
  addedBy: string | null;
  /** Re-use the existing person when a duplicate is found instead of stopping. */
  useExisting?: boolean;
}

export type AddPersonResult =
  | { ok: true; contactId: string; memberId: string | null; reusedExisting: boolean }
  | {
      ok: false;
      code: "DUPLICATE";
      existing: { contactId: string; name: string; hasAccess: boolean; isActive: boolean };
    }
  | { ok: false; code: "SEATS_FULL"; seats: number }
  | { ok: false; code: "PHONE_REQUIRED" }
  | { ok: false; code: "ERROR"; message: string };

interface ExistingContact {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  source_member_id: string | null;
}

async function activeSeatCount(admin: SupabaseClient, contractId: string): Promise<number> {
  const { count } = await admin
    .from("contract_members")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", contractId)
    .eq("is_active", true);
  return count ?? 0;
}

async function loadSeats(admin: SupabaseClient, contractId: string): Promise<number | null> {
  const { data } = await admin.from("contracts").select("seats").eq("id", contractId).maybeSingle();
  return data ? ((data.seats as number | null) ?? 0) : null;
}

/**
 * Add a person to a contract. Creates the contact and, when the person is
 * meant to get access, the member that uses a seat. Sends nothing and
 * provisions nothing.
 */
export async function addPerson(admin: SupabaseClient, input: AddPersonInput): Promise<AddPersonResult> {
  const wantsAccess = input.needsVoucher || input.needsDoor;
  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;

  const { data: contacts, error: listErr } = await admin
    .from("contract_contacts")
    .select("id, full_name, email, phone, is_active, source_member_id")
    .eq("contract_id", input.contractId);
  if (listErr) return { ok: false, code: "ERROR", message: listErr.message };

  const duplicate = ((contacts ?? []) as ExistingContact[]).find(
    (c) => c.is_active && isSamePerson({ phone, email }, c)
  );
  if (duplicate && !input.useExisting) {
    return {
      ok: false,
      code: "DUPLICATE",
      existing: {
        contactId: duplicate.id,
        name: duplicate.full_name,
        hasAccess: !!duplicate.source_member_id,
        isActive: duplicate.is_active,
      },
    };
  }

  if (duplicate && input.useExisting) {
    if (duplicate.source_member_id || !wantsAccess) {
      return { ok: true, contactId: duplicate.id, memberId: duplicate.source_member_id, reusedExisting: true };
    }
    const given = await giveAccess(admin, {
      contractId: input.contractId,
      contactId: duplicate.id,
      needsVoucher: input.needsVoucher,
      needsDoor: input.needsDoor,
      addedBy: input.addedBy,
    });
    if (!given.ok) {
      if (given.code === "SEATS_FULL") return { ok: false, code: "SEATS_FULL", seats: given.seats };
      if (given.code === "PHONE_REQUIRED") return { ok: false, code: "PHONE_REQUIRED" };
      return { ok: false, code: "ERROR", message: given.message ?? "Failed to give access" };
    }
    return { ok: true, contactId: duplicate.id, memberId: given.memberId, reusedExisting: true };
  }

  let memberId: string | null = null;
  if (wantsAccess) {
    if (!phone || phoneDigits(phone).length < 10) return { ok: false, code: "PHONE_REQUIRED" };
    const seats = await loadSeats(admin, input.contractId);
    if (seats === null) return { ok: false, code: "ERROR", message: "Contract not found" };
    if ((await activeSeatCount(admin, input.contractId)) >= seats) return { ok: false, code: "SEATS_FULL", seats };

    const { data: member, error: memberErr } = await admin
      .from("contract_members")
      .insert({
        contract_id: input.contractId,
        name: input.name,
        phone,
        email,
        needs_voucher: input.needsVoucher,
        needs_door: input.needsDoor,
        added_by: input.addedBy,
      })
      .select("id")
      .single();
    if (memberErr || !member) return { ok: false, code: "ERROR", message: memberErr?.message ?? "Failed to add person" };
    memberId = member.id as string;
  }

  const { data: contact, error: contactErr } = await admin
    .from("contract_contacts")
    .insert({
      contract_id: input.contractId,
      full_name: input.name,
      email,
      phone,
      contact_role: input.role,
      is_active: true,
      source_member_id: memberId,
      created_by: input.addedBy,
    })
    .select("id")
    .single();
  if (contactErr || !contact) {
    // Don't leave a seat-holding member behind without its contact.
    if (memberId) await admin.from("contract_members").delete().eq("id", memberId);
    return { ok: false, code: "ERROR", message: contactErr?.message ?? "Failed to add person" };
  }

  return { ok: true, contactId: contact.id as string, memberId, reusedExisting: false };
}

export type GiveAccessResult =
  | { ok: true; memberId: string }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_HAS_ACCESS" | "PHONE_REQUIRED" | "ERROR"; message?: string }
  | { ok: false; code: "SEATS_FULL"; seats: number };

/** Turn a contact-only person into a seat-holding member who gets access. */
export async function giveAccess(
  admin: SupabaseClient,
  input: { contractId: string; contactId: string; needsVoucher: boolean; needsDoor: boolean; addedBy: string | null }
): Promise<GiveAccessResult> {
  const { data: contact } = await admin
    .from("contract_contacts")
    .select("id, full_name, email, phone, is_active, source_member_id")
    .eq("id", input.contactId)
    .eq("contract_id", input.contractId)
    .maybeSingle();
  if (!contact || !contact.is_active) return { ok: false, code: "NOT_FOUND" };
  if (contact.source_member_id) return { ok: false, code: "ALREADY_HAS_ACCESS" };
  if (!contact.phone || phoneDigits(contact.phone).length < 10) return { ok: false, code: "PHONE_REQUIRED" };

  const seats = await loadSeats(admin, input.contractId);
  if (seats === null) return { ok: false, code: "NOT_FOUND" };
  if ((await activeSeatCount(admin, input.contractId)) >= seats) return { ok: false, code: "SEATS_FULL", seats };

  const { data: member, error } = await admin
    .from("contract_members")
    .insert({
      contract_id: input.contractId,
      name: contact.full_name,
      phone: contact.phone,
      email: contact.email,
      needs_voucher: input.needsVoucher,
      needs_door: input.needsDoor,
      added_by: input.addedBy,
    })
    .select("id")
    .single();
  if (error || !member) return { ok: false, code: "ERROR", message: error?.message ?? "Failed to give access" };

  const { error: linkErr } = await admin
    .from("contract_contacts")
    .update({ source_member_id: member.id, updated_at: new Date().toISOString() })
    .eq("id", contact.id);
  if (linkErr) {
    await admin.from("contract_members").delete().eq("id", member.id);
    return { ok: false, code: "ERROR", message: linkErr.message };
  }
  return { ok: true, memberId: member.id as string };
}

/**
 * Makes sure the Pay link in a reminder works before the reminder goes out.
 *
 * Used for every kind of receivable that carries a Razorpay link: billing
 * statements (rent / usage), security deposits, deposit top-ups and ad-hoc
 * invoices. Before a reminder is sent the link's status is read from Razorpay:
 *
 *   • live (created)            → send it as is
 *   • expired / cancelled       → make a replacement (cloned from the old link,
 *                                 same amount and customer), save it, send that
 *   • paid / partially paid     → do NOT send a reminder and do NOT replace the
 *                                 link: money has arrived that the CRM has not
 *                                 reconciled, and a new link would invite a
 *                                 double payment
 *   • status could not be read, or a replacement could not be made
 *                               → no link in the email, with a line telling the
 *                                 customer to reply for a fresh one. Never a
 *                                 blind second link: the payment webhook only
 *                                 watches the stored link id.
 *
 * Replacement links are created silent (no Razorpay SMS/email): the reminder
 * itself is the message the customer gets.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { razorpayLinkDates } from "@/lib/razorpay-link-dates";

export type LinkKind = "statement" | "deposit" | "topup" | "adhoc_invoice" | "booking_pi";

/** live: checked and usable · regenerated: replaced a dead/missing link ·
 *  none: no link on record · disabled: Razorpay switched off in settings ·
 *  paid: Razorpay shows a payment · unconfirmed: could not verify or replace. */
export type LinkOutcome = "live" | "regenerated" | "none" | "disabled" | "paid" | "unconfirmed";

export interface GuardedLink {
  url: string | null;
  /** When the link in `url` was made, per Razorpay; null if unknown. */
  createdAt: string | null;
  outcome: LinkOutcome;
}

const RAZORPAY_TIMEOUT_MS = 8000;

interface RazorpayLink {
  id?: string;
  short_url?: string;
  status?: string;
  description?: string;
  created_at?: number;
  expire_by?: number;
  notes?: Record<string, unknown> | unknown[];
  customer?: { name?: string; email?: string; contact?: string };
  callback_url?: string;
}

export type LinkState = "live" | "paid" | "dead" | "unknown";

/** Razorpay payment link statuses: created, partially_paid, paid, expired, cancelled. */
export function classifyLinkStatus(status: string | undefined | null): LinkState {
  switch (status) {
    case "created": return "live";
    case "paid":
    case "partially_paid": return "paid";
    case "expired":
    case "cancelled": return "dead";
    default: return "unknown";
  }
}

/** Where each kind keeps its link, and the AR mirror an ad-hoc invoice also writes. */
const COLUMNS: Record<LinkKind, { table: string; id: string; url: string; created: string; expires: string }> = {
  statement: {
    table: "billing_statements", id: "razorpay_payment_link_id", url: "razorpay_payment_link_url",
    created: "razorpay_link_created_at", expires: "razorpay_link_expires_at",
  },
  deposit: {
    table: "proposals", id: "deposit_razorpay_link_id", url: "deposit_razorpay_link_url",
    created: "deposit_razorpay_link_created_at", expires: "deposit_razorpay_link_expires_at",
  },
  topup: {
    table: "deposit_topups", id: "razorpay_payment_link_id", url: "razorpay_payment_link_url",
    created: "razorpay_link_created_at", expires: "razorpay_link_expires_at",
  },
  adhoc_invoice: {
    table: "proforma_invoices", id: "razorpay_link_id", url: "razorpay_link_url",
    created: "razorpay_link_created_at", expires: "razorpay_link_expires_at",
  },
  // The statement behind a booking PI shares the booking's link (see replaceDead below).
  booking_pi: {
    table: "billing_statements", id: "razorpay_payment_link_id", url: "razorpay_payment_link_url",
    created: "razorpay_link_created_at", expires: "razorpay_link_expires_at",
  },
};

export interface ReplacementPayloadInput {
  old: RazorpayLink | null;
  amountRupees: number;
  reference: string;
  description: string;
  customer?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  callbackUrl: string;
  nowMs: number;
}

/**
 * The body for the replacement link. Cloned from the dead link where Razorpay
 * still returns it (so notes, customer and callback survive), with a fresh
 * reference_id (Razorpay refuses duplicates and caps it at 40 characters), a
 * fresh expiry, and notifications off.
 */
export function buildReplacementPayload(o: ReplacementPayloadInput): Record<string, unknown> {
  const refBase = o.reference.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 22);
  const oldNotes = o.old?.notes && !Array.isArray(o.old.notes) ? (o.old.notes as Record<string, unknown>) : {};
  const oldCustomer = o.old?.customer;
  const customer = oldCustomer && (oldCustomer.name || oldCustomer.email || oldCustomer.contact) ? oldCustomer : o.customer;
  const payload: Record<string, unknown> = {
    amount: Math.round(o.amountRupees * 100),
    currency: "INR",
    accept_partial: false,
    description: o.old?.description || o.description,
    reference_id: `${refBase}-RG${o.nowMs}`,
    expire_by: Math.floor(o.nowMs / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
    notify: { sms: false, email: false },
    reminder_enable: true,
    notes: { ...oldNotes, ...(o.notes ?? {}), regenerated: "true" },
    callback_url: o.old?.callback_url || o.callbackUrl,
    callback_method: "get",
  };
  if (customer && (customer.name || customer.email || customer.contact)) payload.customer = customer;
  return payload;
}

async function fetchRazorpayLink(auth: string, linkId: string): Promise<RazorpayLink | null> {
  try {
    const res = await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as RazorpayLink;
  } catch (err) {
    console.error("[link-guard] status check failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Date columns are written apart from the id/url so a DB without them never loses a link. */
async function saveDates(admin: SupabaseClient, kind: LinkKind, rowId: string, link: RazorpayLink) {
  const c = COLUMNS[kind];
  const d = razorpayLinkDates(link);
  const { error } = await admin.from(c.table)
    .update({ [c.created]: d.razorpay_link_created_at, [c.expires]: d.razorpay_link_expires_at })
    .eq("id", rowId);
  if (error) console.warn("[link-guard] could not save link dates:", error.message);
  if (kind === "adhoc_invoice") {
    // The AR mirror of an ad-hoc invoice carries the link too.
    await admin.from("billing_statements")
      .update({ razorpay_link_created_at: d.razorpay_link_created_at, razorpay_link_expires_at: d.razorpay_link_expires_at })
      .eq("invoice_id", rowId).is("voided_at", null);
  }
}

async function saveNewLink(admin: SupabaseClient, kind: LinkKind, rowId: string, link: RazorpayLink): Promise<boolean> {
  const c = COLUMNS[kind];
  const { error } = await admin.from(c.table)
    .update({ [c.id]: link.id, [c.url]: link.short_url })
    .eq("id", rowId);
  if (error) {
    console.error("[link-guard] created a replacement link but could not save it:", error.message);
    return false;
  }
  if (kind === "adhoc_invoice") {
    await admin.from("billing_statements")
      .update({ razorpay_payment_link_id: link.id, razorpay_payment_link_url: link.short_url })
      .eq("invoice_id", rowId).is("voided_at", null);
  }
  await saveDates(admin, kind, rowId, link);
  return true;
}

export interface EnsureLinkParams {
  kind: LinkKind;
  rowId: string;
  /** The Razorpay link id stored on the row, if any. */
  linkId: string | null;
  linkUrl: string | null;
  /** Amount in rupees the replacement link should collect. */
  amountRupees: number;
  /** Short reference for the new link's reference_id (statement / proposal / contract / invoice number). */
  reference: string;
  description: string;
  customer?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  callbackUrl: string;
  /** Statements make a link when none exists; the other kinds may be collected manually. */
  createIfMissing: boolean;
  /**
   * Replace an expired or cancelled link with a new one (default). A booking PI
   * must not: its link is shared with the booking, and a replacement saved only
   * on the statement would take a payment the booking never sees.
   */
  replaceDead?: boolean;
}

export async function ensureLiveLink(admin: SupabaseClient, p: EnsureLinkParams): Promise<GuardedLink> {
  const settings = await getCachedSettings(admin, ["razorpay_key_id", "razorpay_key_secret", "razorpay_enabled"]);
  if (settings["razorpay_enabled"] !== "true" || !settings["razorpay_key_id"] || !settings["razorpay_key_secret"]) {
    // Cannot verify anything: statements have always sent no link here, the
    // other kinds keep what is stored.
    return { url: p.kind === "statement" ? null : p.linkUrl, createdAt: null, outcome: "disabled" };
  }
  const auth = Buffer.from(`${settings["razorpay_key_id"]}:${settings["razorpay_key_secret"]}`).toString("base64");
  const unconfirmed: GuardedLink = { url: null, createdAt: null, outcome: "unconfirmed" };

  let old: RazorpayLink | null = null;
  if (p.linkId) {
    const link = await fetchRazorpayLink(auth, p.linkId);
    if (!link) return unconfirmed;
    const state = classifyLinkStatus(link.status);
    const createdAt = razorpayLinkDates(link).razorpay_link_created_at;
    if (state === "paid") return { url: null, createdAt, outcome: "paid" };
    if (state === "unknown") return unconfirmed;
    if (state === "live") {
      // Fills the dates for links made before they were recorded.
      await saveDates(admin, p.kind, p.rowId, link);
      return { url: link.short_url || p.linkUrl, createdAt, outcome: "live" };
    }
    if (p.replaceDead === false) return unconfirmed;
    old = link; // expired / cancelled: replace below
  } else if (!p.createIfMissing) {
    return { url: p.linkUrl, createdAt: null, outcome: "none" };
  }

  const payload = buildReplacementPayload({
    old, amountRupees: p.amountRupees, reference: p.reference, description: p.description,
    customer: p.customer, notes: p.notes, callbackUrl: p.callbackUrl, nowMs: Date.now(),
  });
  try {
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[link-guard] replacement link refused:", await res.text());
      return unconfirmed;
    }
    const created = (await res.json()) as RazorpayLink;
    if (!created.id || !created.short_url) return unconfirmed;
    if (!(await saveNewLink(admin, p.kind, p.rowId, created))) return unconfirmed;
    return { url: created.short_url, createdAt: razorpayLinkDates(created).razorpay_link_created_at, outcome: "regenerated" };
  } catch (err) {
    console.error("[link-guard] replacement link failed:", err instanceof Error ? err.message : err);
    return unconfirmed;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lead = any;

/** Billing statement (rent / usage / proforma) link. */
export function ensureStatementLink(
  admin: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statement: any, lead: Lead, appUrl: string, partyRef: string,
): Promise<GuardedLink> {
  const phone = (lead?.mobile || lead?.phone || "").replace(/\s/g, "");
  const name = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer";
  return ensureLiveLink(admin, {
    kind: "statement",
    rowId: statement.id as string,
    linkId: (statement.razorpay_payment_link_id as string | null) || null,
    linkUrl: (statement.razorpay_payment_link_url as string | null) || null,
    // Defensive rupee-rounding, as when the link is first made.
    amountRupees: Math.round(Number(statement.total_amount)),
    reference: statement.statement_number as string,
    description: `${statement.statement_number} — ${partyRef}`,
    customer: { name, ...(lead?.email ? { email: lead.email } : {}), ...(phone ? { contact: phone } : {}) },
    notes: { statement_id: statement.id as string, contract_number: partyRef },
    callbackUrl: `${appUrl}/billing`,
    createIfMissing: true,
  });
}

export interface ReceivableLinkInput {
  kind: Exclude<LinkKind, "statement">;
  id: string;
  reference: string;
  amount: number;
  partyName: string;
  email: string | null;
  phone: string | null;
  linkId: string | null;
  linkUrl: string | null;
  appUrl: string;
}

/** Deposit, top-up or ad-hoc invoice link. Never invents a link where there was none. */
export function ensureReceivableLink(admin: SupabaseClient, i: ReceivableLinkInput): Promise<GuardedLink> {
  const phone = (i.phone || "").replace(/\s/g, "");
  const meta: Record<ReceivableLinkInput["kind"], { description: string; notes: Record<string, string>; callback: string }> = {
    deposit: {
      description: `Security Deposit — ${i.reference} — The WorkVilla`,
      notes: { proposal_id: i.id, proposal_number: i.reference, type: "security_deposit" },
      callback: "/proposals",
    },
    topup: {
      description: `Additional Security Deposit — ${i.reference} — The WorkVilla`,
      notes: { contract_number: i.reference, type: "deposit_topup" },
      callback: "/contracts",
    },
    adhoc_invoice: {
      description: `${i.reference} — The WorkVilla`,
      notes: { invoice_id: i.id, invoice_number: i.reference, type: "adhoc_invoice" },
      callback: "/invoices",
    },
    booking_pi: {
      description: `Booking ${i.reference} — The WorkVilla`,
      notes: { statement_id: i.id, type: "booking_pi" },
      callback: "/bookings",
    },
  };
  const m = meta[i.kind];
  return ensureLiveLink(admin, {
    kind: i.kind, rowId: i.id, linkId: i.linkId, linkUrl: i.linkUrl,
    amountRupees: i.amount, reference: i.reference, description: m.description,
    customer: { name: i.partyName, ...(i.email ? { email: i.email } : {}), ...(phone ? { contact: phone } : {}) },
    notes: m.notes, callbackUrl: `${i.appUrl}${m.callback}`, createIfMissing: false,
    replaceDead: i.kind !== "booking_pi",
  });
}

/** The line shown instead of a Pay button when no working link could be secured. */
export const LINK_UNAVAILABLE_NOTE =
  "We couldn't generate a payment link just now. Reply to this email and we'll send you a fresh one, or pay by bank transfer using the details on the invoice.";

/**
 * Inserts reminder-history rows carrying the link that went out. If the
 * database does not have the link columns yet, the rows are written without
 * them — a missing column must never cost a send its history.
 */
export async function insertReminderHistory(
  admin: SupabaseClient,
  table: "billing_reminder_sends" | "receivable_reminder_sends",
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await admin.from(table).insert(rows);
  if (!error || !/pay_link/.test(error.message || "")) return;
  const stripped = rows.map((r) => {
    const copy = { ...r };
    delete copy.pay_link_url; delete copy.pay_link_created_at; delete copy.pay_link_outcome;
    return copy;
  });
  await admin.from(table).insert(stripped);
}

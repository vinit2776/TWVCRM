// Turns an inbound WhatsApp message (MSG91 webhook) into a lead + Enquiry Log row, the same
// way the public Google Ads / Meta Ads / walk-in forms do. Pure helpers are exported for tests.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { sendPushToAll } from "@/lib/push";
import { messaging } from "@/lib/whatsapp";
import { logAudit } from "@/lib/audit";
import { CUSTOMER_BOOKING_WINDOW_DAYS, classifyByRules, decideGrouping, type TriageContext, type TriageKind } from "@/lib/whatsapp-triage";
import { COUNTED_BOOKING_STATUSES } from "@/lib/enquiry-progress";
import { classifyWithAi } from "@/lib/whatsapp-triage-ai";
import { appendToOpenComplaint, recordComplaint } from "@/lib/complaints-server";

const MAX_STORED_MESSAGES = 20;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app";

/** Number to store on the lead: 10 digits for an Indian number (as the forms store it),
 *  the full digit string for anything else. Null when there is nothing usable. */
export function normaliseWhatsAppNumber(raw: string): { mobile: string; last10: string } | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const last10 = digits.slice(-10);
  const indian = digits.length === 10 || (digits.length === 12 && digits.startsWith("91"));
  return { mobile: indian ? last10 : digits, last10 };
}

/** MSG91 may carry the WhatsApp profile name under one of several keys depending on the
 *  webhook template; none is guaranteed. Returns null when absent. */
export function pickProfileName(event: Record<string, unknown>): string | null {
  const keys = ["profileName", "profile_name", "customerName", "contactName", "senderName"];
  for (const k of keys) {
    const v = event[k];
    if (typeof v === "string" && v.trim() && v.trim() !== "[object Object]") return v.trim().slice(0, 80);
  }
  return null;
}

const OUTBOUND_DIRECTION = /^(out|outbound|outgoing|sent)$/i;

/** Tells an inbound customer message from an outbound delivery report.
 *  Older MSG91 inbound payloads had no status at all. Since the inbound webhook was
 *  re-registered they carry `eventName`/`status: "submitted"` plus a `direction` field,
 *  so "no status" alone no longer identifies them. A genuine delivery report always has
 *  a requestId (it is how we match it to the message we sent); a customer message has
 *  none, so a status-bearing event is inbound only without a requestId and with a
 *  direction that is not outbound. */
export function isInboundEvent(
  event: Record<string, unknown>,
  rawStatus: string | undefined,
  requestId: string | undefined
): boolean {
  if (!rawStatus) return true;
  if (requestId) return false;
  const dir = typeof event.direction === "string" ? event.direction.trim() : "";
  return dir !== "" && !OUTBOUND_DIRECTION.test(dir);
}

export function splitName(name: string | null): { first: string; last: string } {
  if (!name) return { first: "WhatsApp contact", last: "-" };
  const parts = name.split(/\s+/);
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : "-" };
}

export interface InboundWhatsAppEnquiry {
  senderNumber: string;
  matchedLeadId: string | null;
  messageBody: string;
  messageType: string;
  profileName: string | null;
  referral?: { sourceType?: string; sourceUrl?: string; headline?: string };
}

export interface IntakeResult {
  /** The lead the message belongs to; null when a message was dropped from the enquiry flow. */
  leadId: string | null;
  reference: string | null;
  kind: TriageKind;
  outcome: "new_lead" | "re_enquiry" | "joined_open_enquiry" | "logged_only" | "spam_stashed";
}

interface StoredMessage { at: string; text: string }

type LatestRow = {
  id: string;
  reference: string;
  payload: { messages?: StoredMessage[] } | null;
  received_at: string;
  resolved_at: string | null;
  resolution_outcome: string | null;
  claimed_by: string | null;
  next_step: string | null;
};

async function appendMessage(supabase: SupabaseClient, row: Pick<LatestRow, "id" | "payload">, message: StoredMessage) {
  const payload = row.payload ?? {};
  const messages = [...(payload.messages ?? []), message].slice(-MAX_STORED_MESSAGES);
  await supabase.from("lead_enquiries").update({ payload: { ...payload, messages } }).eq("id", row.id);
}

/** Decides what an inbound WhatsApp message is (enquiry, customer, complaint, spam, ack, unclear)
 *  and acts on it: a new enquiry, joining the live conversation, a log entry only, or a quiet
 *  trip to the Spam section. Nothing is ever deleted: spam is a restorable enquiry. */
export async function ingestInboundWhatsAppEnquiry(
  supabase: SupabaseClient,
  input: InboundWhatsAppEnquiry
): Promise<IntakeResult | null> {
  const num = normaliseWhatsAppNumber(input.senderNumber);
  if (!num) return null;

  const now = new Date();
  const message: StoredMessage = { at: now.toISOString(), text: input.messageBody.slice(0, 1000) };

  // What we already know about this sender.
  let leadStatus: string | null = null;
  let hasActiveContract = false;
  let hasRecentBooking = false;
  let latest: LatestRow | null = null;
  let lastTouchAt: string | null = null;
  let displayName = input.profileName ?? "WhatsApp contact";
  if (input.matchedLeadId) {
    const id = input.matchedLeadId;
    const bookingSince = new Date(Date.now() - CUSTOMER_BOOKING_WINDOW_DAYS * 86_400_000).toISOString();
    const [{ data: lead }, { count: activeCount }, { data: latestRow }, { count: bookingCount }] = await Promise.all([
      supabase.from("leads").select("status, first_name, last_name").eq("id", id).maybeSingle(),
      supabase.from("contracts").select("id", { count: "exact", head: true }).eq("lead_id", id).eq("status", "active"),
      supabase
        .from("lead_enquiries")
        .select("id, reference, payload, received_at, resolved_at, resolution_outcome, claimed_by, next_step")
        .eq("lead_id", id)
        .eq("source", "whatsapp")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", id)
        .in("status", COUNTED_BOOKING_STATUSES)
        .gte("created_at", bookingSince),
    ]);
    hasRecentBooking = (bookingCount ?? 0) > 0;
    leadStatus = (lead?.status as string | undefined) ?? null;
    hasActiveContract = (activeCount ?? 0) > 0;
    latest = (latestRow as LatestRow | null) ?? null;
    const full = `${lead?.first_name ?? ""} ${lead?.last_name === "-" ? "" : lead?.last_name ?? ""}`.trim();
    if (full) displayName = full;
    if (latest) {
      const { data: upd } = await supabase
        .from("enquiry_updates")
        .select("created_at")
        .eq("enquiry_id", latest.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const times = [latest.received_at, ...(latest.payload?.messages ?? []).map((m) => m.at), upd?.created_at as string | undefined]
        .filter((t): t is string => !!t)
        .sort();
      lastTouchAt = times.at(-1) ?? latest.received_at;
    }
  }

  const grouping = decideGrouping(
    latest && lastTouchAt
      ? {
          resolved_at: latest.resolved_at,
          resolution_outcome: latest.resolution_outcome,
          claimed: !!latest.claimed_by,
          hasNextStep: !!latest.next_step,
          last_touch_at: lastTouchAt,
        }
      : null,
    now
  );
  const hasOpenEnquiry = !!latest && !latest.resolved_at && grouping === "join";

  const ctx: TriageContext = {
    isCustomer: hasActiveContract || hasRecentBooking,
    hasActiveContract,
    leadStatus,
    hasReferral: !!input.referral,
    knownSender: !!input.matchedLeadId,
    hasOpenEnquiry,
  };
  let triage = classifyByRules(input.messageBody, input.messageType, ctx);
  if (triage.kind === "unsure") triage = (await classifyWithAi(supabase, input.messageBody, ctx)) ?? triage;
  // Never turn a real lead into junk on a wording guess: ask a person instead.
  if (triage.kind === "spam" && input.matchedLeadId && leadStatus !== "junk" && leadStatus !== "new") {
    triage = { kind: "unsure", reason: "looks like spam but the number belongs to a known lead", source: triage.source };
  }
  const kind = triage.kind;

  // Customers, complaints and bare acknowledgements are not enquiries.
  if (kind === "customer" || kind === "complaint" || kind === "low_signal") {
    if (kind === "low_signal" && hasOpenEnquiry && latest) {
      await appendMessage(supabase, latest, message);
      return { leadId: input.matchedLeadId, reference: latest.reference, kind, outcome: "joined_open_enquiry" };
    }
    if (kind === "customer" && input.matchedLeadId) {
      // Part of a complaint they already raised? Then it goes on that complaint.
      try {
        await appendToOpenComplaint(supabase, input.matchedLeadId, input.messageBody);
      } catch (err) {
        console.error("[whatsapp-intake] complaint follow-up failed:", err instanceof Error ? err.message : "unknown");
      }
    }
    if (kind === "complaint" && input.matchedLeadId) {
      await flagComplaint(supabase, input.matchedLeadId, displayName, num.mobile, input.messageBody);
    }
    return { leadId: input.matchedLeadId, reference: null, kind, outcome: "logged_only" };
  }

  // Spam is stashed, not discarded: a resolved "spam" enquiry the team can restore.
  if (kind === "spam") {
    if (latest?.resolution_outcome === "spam") {
      await appendMessage(supabase, latest, message);
      return { leadId: input.matchedLeadId, reference: latest.reference, kind, outcome: "spam_stashed" };
    }
    const leadId = input.matchedLeadId ?? (await createLead(supabase, input, num.mobile, "junk"));
    if (!leadId) return null;
    const { data: stashed } = await supabase
      .from("lead_enquiries")
      .insert({
        lead_id: leadId,
        source: "whatsapp",
        is_re_enquiry: !!input.matchedLeadId,
        resolved_at: now.toISOString(),
        resolution_outcome: "spam",
        payload: { name: displayName, mobile: num.mobile, messages: [message], triage: { kind, reason: triage.reason, source: triage.source } },
      })
      .select("reference")
      .single();
    return { leadId, reference: (stashed?.reference as string | undefined) ?? null, kind, outcome: "spam_stashed" };
  }

  // A real (or possibly real) enquiry: same conversation, or a new one?
  if (grouping === "join" && latest) {
    await appendMessage(supabase, latest, message);
    return { leadId: input.matchedLeadId, reference: latest.reference, kind, outcome: "joined_open_enquiry" };
  }
  if (grouping === "customer_message") {
    return { leadId: input.matchedLeadId, reference: null, kind, outcome: "logged_only" };
  }

  const leadId = input.matchedLeadId ?? (await createLead(supabase, input, num.mobile, "new"));
  if (!leadId) return null;

  const isReEnquiry = !!input.matchedLeadId;
  const needsReview = kind === "unsure";
  const payload: Record<string, unknown> = {
    name: displayName,
    mobile: num.mobile,
    messages: [message],
    message_type: input.messageType,
  };
  if (input.referral) payload.referral = input.referral;
  if (needsReview) payload.triage = { kind, reason: triage.reason, source: triage.source };

  const { data: enquiry, error: enqErr } = await supabase
    .from("lead_enquiries")
    .insert({ lead_id: leadId, source: "whatsapp", is_re_enquiry: isReEnquiry, payload })
    .select("reference")
    .single();
  // A failed enquiry row must not lose the lead; log without PII and carry on.
  if (enqErr) console.error("[whatsapp-intake] could not record enquiry:", enqErr.message);
  const reference = (enquiry?.reference as string | undefined) ?? null;

  await alertStaff(supabase, {
    leadId, reference, displayName, isReEnquiry, needsReview,
    mobile: num.mobile, body: input.messageBody, referral: input.referral,
  });

  return { leadId, reference, kind, outcome: isReEnquiry ? "re_enquiry" : "new_lead" };
}

async function createLead(
  supabase: SupabaseClient,
  input: InboundWhatsAppEnquiry,
  mobile: string,
  status: "new" | "junk"
): Promise<string | null> {
  const { first, last } = splitName(input.profileName);
  const { data: lead, error } = await supabase
    .from("leads")
    .insert({
      first_name: first,
      last_name: last,
      mobile,
      description: input.messageBody.slice(0, 1000) || null,
      source: "whatsapp",
      status,
      rating: "none",
      score: 0,
      tags: ["whatsapp-form"],
    })
    .select("id")
    .single();
  if (error || !lead) {
    console.error("[whatsapp-intake] could not create lead:", error?.message);
    return null;
  }
  void logAudit(supabase, {
    entityType: "lead",
    entityId: lead.id as string,
    action: "create",
    performedBy: "system:whatsapp-inbound",
  });
  return lead.id as string;
}

/** A customer with an active contract wrote something that sounds like a problem: no enquiry.
 *  It becomes (or joins) a complaint for a person to assess, and the team is told. */
async function flagComplaint(supabase: SupabaseClient, leadId: string, name: string, phone: string, text: string) {
  let recorded: Awaited<ReturnType<typeof recordComplaint>> = null;
  try {
    recorded = await recordComplaint(supabase, { leadId, customerName: name, customerPhone: phone, text });
  } catch (err) {
    console.error("[whatsapp-intake] complaint record failed:", err instanceof Error ? err.message : "unknown");
  }
  await Promise.allSettled([
    supabase.from("activities").insert({
      lead_id: leadId,
      type: "note",
      subject: `WhatsApp: possible complaint${recorded ? ` (${recorded.reference})` : ""}`,
      description: "Flagged automatically: an active customer wrote something that sounds like a problem. See the WhatsApp reply note.",
    }),
    // A message added to a complaint someone is already assessing does not need another alert.
    recorded?.appended
      ? Promise.resolve()
      : sendPushToAll({
          title: `Customer complaint${recorded ? ` ${recorded.reference}` : ""}: ${name}`,
          body: "Possible complaint or support request on WhatsApp",
          url: `${APP_URL}/facility/issues?view=complaints`,
          tag: `wa-complaint-${leadId}`,
        }),
  ]);
}

async function alertStaff(
  supabase: SupabaseClient,
  a: {
    leadId: string; reference: string | null; displayName: string; isReEnquiry: boolean; needsReview?: boolean;
    mobile: string; body: string; referral?: InboundWhatsAppEnquiry["referral"];
  }
) {
  const title = `${a.needsReview ? "❓ Please review" : a.isReEnquiry ? "🔁 Re-Enquiry" : "🔔 New Enquiry"}${a.reference ? ` ${a.reference}` : ""} — ${a.displayName} via WhatsApp`;
  const url = `${APP_URL}/leads/${a.leadId}`;

  const [{ data: staffRows }, { data: salesRows }] = await Promise.all([
    supabase.from("users").select("email").in("role", ["admin", "manager"]).eq("is_active", true),
    supabase.from("users").select("phone").in("role", ["sales_rep", "manager"]).eq("is_active", true)
      .not("phone", "is", null).neq("phone", ""),
  ]);
  const recipients = Array.from(new Set([
    "space@theworkvilla.com",
    ...((staffRows ?? []) as { email: string }[]).map((u) => u.email).filter(Boolean),
  ]));
  const phones = ((salesRows ?? []) as { phone: string }[]).map((u) => u.phone).filter(Boolean);
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

  const html = `<div style="font-family:sans-serif;font-size:14px;color:#111827">
    <p><strong>${esc(title)}</strong></p>
    <p>Mobile: ${esc(a.mobile)}</p>
    ${a.referral?.headline ? `<p>Ad: ${esc(a.referral.headline)}</p>` : ""}
    <p>Message: ${esc(a.body.slice(0, 500))}</p>
    <p><a href="${url}">View in CRM →</a></p></div>`;

  await Promise.allSettled([
    resend.emails.send({ from: EMAIL_FROM, to: recipients, subject: title, html }),
    sendPushToAll({
      title,
      body: `${a.isReEnquiry ? "Messaged again" : "New message"} on WhatsApp${a.reference ? ` · ${a.reference}` : ""}`,
      url,
      tag: `wa-enquiry-${a.leadId}`,
    }),
    ...phones.map((p) => messaging.internalNewLead(p, a.displayName, "—", "WhatsApp", a.leadId)),
  ]);
}

// Turns an inbound WhatsApp message (MSG91 webhook) into a lead + Enquiry Log row, the same
// way the public Google Ads / Meta Ads / walk-in forms do. Pure helpers are exported for tests.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { sendPushToAll } from "@/lib/push";
import { messaging } from "@/lib/whatsapp";
import { logAudit } from "@/lib/audit";

/** One open WhatsApp enquiry per number per window; later messages join it. */
export const WHATSAPP_ENQUIRY_WINDOW_HOURS = 24;
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
  leadId: string;
  reference: string | null;
  outcome: "new_lead" | "re_enquiry" | "joined_open_enquiry";
}

interface StoredMessage { at: string; text: string }

export async function ingestInboundWhatsAppEnquiry(
  supabase: SupabaseClient,
  input: InboundWhatsAppEnquiry
): Promise<IntakeResult | null> {
  const num = normaliseWhatsAppNumber(input.senderNumber);
  if (!num) return null;

  const now = new Date().toISOString();
  const message: StoredMessage = { at: now, text: input.messageBody.slice(0, 1000) };

  if (input.matchedLeadId) {
    const since = new Date(Date.now() - WHATSAPP_ENQUIRY_WINDOW_HOURS * 3_600_000).toISOString();
    const { data: open } = await supabase
      .from("lead_enquiries")
      .select("id, reference, payload")
      .eq("lead_id", input.matchedLeadId)
      .eq("source", "whatsapp")
      .is("resolved_at", null)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (open) {
      const payload = (open.payload ?? {}) as { messages?: StoredMessage[] };
      const messages = [...(payload.messages ?? []), message].slice(-MAX_STORED_MESSAGES);
      await supabase.from("lead_enquiries").update({ payload: { ...payload, messages } }).eq("id", open.id);
      return { leadId: input.matchedLeadId, reference: open.reference as string, outcome: "joined_open_enquiry" };
    }
  }

  let leadId = input.matchedLeadId;
  let displayName = input.profileName ?? "WhatsApp contact";
  if (leadId) {
    const { data: known } = await supabase.from("leads").select("first_name, last_name").eq("id", leadId).maybeSingle();
    const full = `${known?.first_name ?? ""} ${known?.last_name === "-" ? "" : known?.last_name ?? ""}`.trim();
    if (full) displayName = full;
  }

  if (!leadId) {
    const { first, last } = splitName(input.profileName);
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        first_name: first,
        last_name: last,
        mobile: num.mobile,
        description: input.messageBody.slice(0, 1000) || null,
        source: "whatsapp",
        status: "new",
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
    leadId = lead.id as string;
    void logAudit(supabase, {
      entityType: "lead",
      entityId: leadId,
      action: "create",
      performedBy: "system:whatsapp-inbound",
    });
  }

  const isReEnquiry = !!input.matchedLeadId;
  const payload: Record<string, unknown> = {
    name: displayName,
    mobile: num.mobile,
    messages: [message],
    message_type: input.messageType,
  };
  if (input.referral) payload.referral = input.referral;

  const { data: enquiry, error: enqErr } = await supabase
    .from("lead_enquiries")
    .insert({ lead_id: leadId, source: "whatsapp", is_re_enquiry: isReEnquiry, payload })
    .select("reference")
    .single();
  // A failed enquiry row must not lose the lead; log without PII and carry on.
  if (enqErr) console.error("[whatsapp-intake] could not record enquiry:", enqErr.message);
  const reference = (enquiry?.reference as string | undefined) ?? null;

  await alertStaff(supabase, { leadId, reference, displayName, isReEnquiry, mobile: num.mobile, body: input.messageBody, referral: input.referral });

  return { leadId, reference, outcome: isReEnquiry ? "re_enquiry" : "new_lead" };
}

async function alertStaff(
  supabase: SupabaseClient,
  a: {
    leadId: string; reference: string | null; displayName: string; isReEnquiry: boolean;
    mobile: string; body: string; referral?: InboundWhatsAppEnquiry["referral"];
  }
) {
  const title = `${a.isReEnquiry ? "🔁 Re-Enquiry" : "🔔 New Enquiry"}${a.reference ? ` ${a.reference}` : ""} — ${a.displayName} via WhatsApp`;
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

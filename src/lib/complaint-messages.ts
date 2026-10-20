// WhatsApp messages to a customer about their complaint, sent through MSG91 templates.
// The template NAMES come from env vars so each can be switched on the moment MSG91 approves it:
//   MSG91_WA_TEMPLATE_COMPLAINT_RECEIVED  {{1}} first name, {{2}} complaint reference
//   MSG91_WA_TEMPLATE_COMPLAINT_UPDATE    {{1}} first name, {{2}} reference, {{3}} message
//   MSG91_WA_TEMPLATE_COMPLAINT_RESOLVED  {{1}} first name, {{2}} reference, {{3}} rating link
// A template that isn't configured is never an error: the reply is recorded as "skipped" and the
// team is told, so assessing and work orders work from day one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsApp } from "@/lib/whatsapp";
import { MAX_REPLY_CHARS } from "@/lib/complaint-messages-shared";
import { REQUEST_DONE_TEXT, type RequestType } from "@/lib/requests";

export type ReplyKind = "received" | "update" | "resolved";
export type ReplyStatus = "sent" | "failed" | "skipped";
export type ReplyOutcome = { status: ReplyStatus; detail?: string };

// .trim(): a stray newline pasted into a Vercel env var makes MSG91 reject the template name.
const ENV_NAME: Record<ReplyKind, string> = {
  received: "MSG91_WA_TEMPLATE_COMPLAINT_RECEIVED",
  update: "MSG91_WA_TEMPLATE_COMPLAINT_UPDATE",
  resolved: "MSG91_WA_TEMPLATE_COMPLAINT_RESOLVED",
};
const templateName = (kind: ReplyKind) => process.env[ENV_NAME[kind]]?.trim() || undefined;

/** Which templates are switched on, for the UI to say "template not approved yet". */
export function complaintTemplateStatus(): Record<ReplyKind, boolean> {
  return { received: !!templateName("received"), update: !!templateName("update"), resolved: !!templateName("resolved") };
}

/** "Rahul S." -> "Rahul"; nothing usable -> "there" ("Hi there"). */
export function firstNameOf(name: string | null | undefined): string {
  const w = (name ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}'.-]/gu, "");
  return w ? w : "there";
}

export { MAX_REPLY_CHARS };

/** A template variable can't hold line breaks; collapse whitespace and cap the length. */
export function cleanReplyText(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > MAX_REPLY_CHARS ? `${s.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…` : s;
}

export function ratingUrl(token: string | null | undefined): string | null {
  if (!token) return null;
  return `${process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com"}/facility/satisfaction/${token}`;
}

/** Sends one complaint message and records it, whatever happens. Never throws. */
export async function sendComplaintReply(
  admin: SupabaseClient,
  input: { complaintId: string; kind: ReplyKind; text?: string; ratingLink?: string | null; sentBy?: string | null }
): Promise<ReplyOutcome> {
  const { complaintId, kind } = input;
  const record = async (outcome: ReplyOutcome, message: string | null): Promise<ReplyOutcome> => {
    const { error } = await admin
      .from("complaint_replies")
      .insert({ complaint_id: complaintId, kind, message, status: outcome.status, detail: outcome.detail ?? null, sent_by: input.sentBy ?? null });
    if (error) console.error("[complaint-messages] could not log reply:", error.message);
    return outcome;
  };

  try {
    const { data: c } = await admin
      .from("customer_complaints")
      .select("reference, customer_name, customer_phone, lead_id")
      .eq("id", complaintId)
      .single();
    if (!c) return { status: "failed", detail: "complaint not found" };

    // The acknowledgement and the closing message go once per complaint.
    if (kind !== "update") {
      const { data: already } = await admin
        .from("complaint_replies")
        .select("id")
        .eq("complaint_id", complaintId)
        .eq("kind", kind)
        .eq("status", "sent")
        .limit(1)
        .maybeSingle();
      if (already) return { status: "skipped", detail: "already sent" };
    }

    const template = templateName(kind);
    const text = kind === "update" ? cleanReplyText(input.text ?? "") : "";
    if (kind === "update" && !text) return { status: "skipped", detail: "no message" };
    if (!template) return record({ status: "skipped", detail: "template not configured" }, text || null);
    if (!c.customer_phone) return record({ status: "skipped", detail: "no phone number" }, text || null);
    if (kind === "resolved" && !input.ratingLink) return record({ status: "skipped", detail: "no rating link" }, null);

    const params =
      kind === "received"
        ? [firstNameOf(c.customer_name as string), c.reference as string]
        : kind === "update"
          ? [firstNameOf(c.customer_name as string), c.reference as string, text]
          : [firstNameOf(c.customer_name as string), c.reference as string, input.ratingLink as string];

    const result = await sendWhatsApp({
      to: c.customer_phone as string,
      template,
      params,
      // Attributed to the customer's lead so the delivery report lands on their timeline.
      entityType: c.lead_id ? "lead" : undefined,
      entityId: (c.lead_id as string | null) ?? undefined,
    });
    return record(
      result.success ? { status: "sent" } : { status: "failed", detail: (result.error ?? "send failed").slice(0, 300) },
      text || (kind === "received" ? "Acknowledgement" : "Resolved + rating link")
    );
  } catch (err) {
    console.error("[complaint-messages] unexpected:", err instanceof Error ? err.message : "unknown");
    return { status: "failed", detail: "unexpected error" };
  }
}

/** The work order behind a complaint has been resolved: tell the customer and ask for a rating.
 *  Safe to call for any issue: does nothing unless a complaint is linked to it. */
export async function notifyComplaintResolved(admin: SupabaseClient, issueId: string, satisfactionToken: string | null) {
  const { data: complaint } = await admin.from("customer_complaints").select("id").eq("issue_id", issueId).maybeSingle();
  if (!complaint) return;
  await sendComplaintReply(admin, { complaintId: complaint.id as string, kind: "resolved", ratingLink: ratingUrl(satisfactionToken) });
}

/** The task behind a customer request was marked done: tell the customer, once. Safe to call for
 *  any task: does nothing unless a request is linked to it. */
export async function notifyRequestTaskDone(admin: SupabaseClient, taskId: string) {
  const { data: c } = await admin.from("customer_complaints").select("id, kind, request_type").eq("task_id", taskId).maybeSingle();
  if (!c || c.kind !== "request" || !c.request_type) return;
  const text = REQUEST_DONE_TEXT[c.request_type as RequestType];
  if (!text) return;
  const { data: already } = await admin
    .from("complaint_replies")
    .select("id")
    .eq("complaint_id", c.id)
    .eq("kind", "update")
    .eq("message", text)
    .eq("status", "sent")
    .limit(1)
    .maybeSingle();
  if (already) return;
  await sendComplaintReply(admin, { complaintId: c.id as string, kind: "update", text });
}

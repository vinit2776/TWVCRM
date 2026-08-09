/**
 * MSG91 Messaging Webhook
 *
 * Receives delivery status callbacks for both WhatsApp and SMS sent via MSG91.
 *
 * GET  — Simple token verification (used when registering the webhook URL in MSG91)
 * POST — Delivery status updates + inbound messages from MSG91
 *
 * Authentication
 * --------------
 * MSG91 does not sign webhook payloads, so a shared secret is the strongest
 * mechanism available. Its webhook config accepts arbitrary custom headers, so
 * both webhooks send `x-msg91-webhook-token: <MSG91_WEBHOOK_TOKEN>`.
 *
 * Register at MSG91 → WhatsApp → Webhook, on BOTH "CRM Delivery Status" and
 * "CRM Inbound Messages":
 *   Callback URL: https://<your-domain>/api/webhooks/whatsapp
 *   Header:       x-msg91-webhook-token: <MSG91_WEBHOOK_TOKEN env var>
 *
 * A `?token=` query parameter is accepted as a fallback, because MSG91's UI
 * lets the URL be edited more easily than the headers. Without authentication
 * anyone could forge delivery statuses and inject fake inbound messages and
 * lead activities.
 *
 * If MSG91_WEBHOOK_TOKEN is unset the request is allowed through with a
 * warning — failing closed on a missing env var would silently drop every
 * delivery report instead of surfacing the misconfiguration.
 *
 * MSG91 POST body (WhatsApp delivery report) — per its resPayloadFormat:
 *   { "status": "...", "requestId": "...", "to": "91...", "from": "91...",
 *     "templateName": "...", "channel": "whatsapp", "reason": "...", ... }
 *
 * MSG91 POST body (inbound message):
 *   { "from": "91...", "text": "...", "channel": "whatsapp",
 *     "messageType": "text", "requestId": "...", ... }
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

const WEBHOOK_TOKEN = process.env.MSG91_WEBHOOK_TOKEN?.trim() || undefined;

const TOKEN_HEADER = "x-msg91-webhook-token";

/**
 * Pulls the readable message out of an inbound MSG91 event.
 *
 * The top-level `text` field is only populated for plain typed messages. For
 * everything else it arrives empty and the real content sits inside `content`,
 * which is itself a JSON *string*. Requiring `text` therefore dropped most
 * inbound traffic — of 51 inbound events between 1–26 Jul 2026, only 8 had a
 * usable `text`.
 *
 * Observed shapes, by frequency:
 *   29x  Click-to-WhatsApp ad reply — content.referral.text holds the customer's
 *        message; the sibling body/headline are the *ad creative*, not the
 *        customer's words. These are inbound leads from Instagram/Facebook.
 *   11x  content is null (reactions, stickers and similar unsupported types)
 *    7x  plain text — content.text
 *    3x  media — content.attachment_url
 *    1x  WhatsApp Flow submission — content.reply.response_json (a form payload)
 */
export function parseInboundMessage(event: Record<string, unknown>): {
  body: string;
  messageType: string;
  referral?: { sourceType?: string; sourceUrl?: string; headline?: string };
  attachmentUrl?: string;
} {
  const messageType = String(event.messageType ?? "text");
  const topText = typeof event.text === "string" ? event.text.trim() : "";
  // MSG91 renders {{text}} by stringifying whatever it has, so a structured
  // message arrives as the literal "[object Object]". Treat that as absent —
  // for Flow submissions the real content (name, email) is in `content`.
  if (topText && topText !== "[object Object]") return { body: topText, messageType };

  const raw = event.content;
  if (raw == null || raw === "null" || raw === "") {
    return { body: `[${messageType}]`, messageType };
  }

  // `content` is a JSON string for every structured type; a bare string for some.
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return { body: raw.trim(), messageType }; }
  }
  if (parsed == null || typeof parsed !== "object") {
    return { body: String(parsed ?? `[${messageType}]`), messageType };
  }
  const c = parsed as Record<string, unknown>;

  if (typeof c.text === "string" && c.text.trim()) {
    return { body: c.text.trim(), messageType };
  }

  const referral = c.referral as Record<string, unknown> | undefined;
  if (referral) {
    const msg = typeof referral.text === "string" ? referral.text.trim() : "";
    return {
      body: msg || `[replied to ${referral.source_type ?? "ad"}]`,
      messageType,
      referral: {
        sourceType: referral.source_type as string | undefined,
        sourceUrl:  referral.source_url as string | undefined,
        headline:   referral.headline as string | undefined,
      },
    };
  }

  const reply = c.reply as Record<string, unknown> | undefined;
  if (reply) {
    // WhatsApp Flow form submission — response_json is another nested JSON string.
    if (typeof reply.response_json === "string") {
      try {
        const fields = JSON.parse(reply.response_json) as Record<string, unknown>;
        const pairs = Object.entries(fields)
          .filter(([k]) => k !== "flow_token")
          // "screen_0_Name_0" -> "Name"
          .map(([k, v]) => `${k.replace(/^screen_\d+_/, "").replace(/_\d+$/, "")}: ${v}`);
        if (pairs.length) return { body: `[form] ${pairs.join(", ")}`, messageType };
      } catch { /* fall through to the plain reply body */ }
    }
    if (typeof reply.body === "string" && reply.body.trim()) {
      return { body: reply.body.trim(), messageType };
    }
  }

  if (typeof c.attachment_url === "string" && c.attachment_url) {
    return { body: `[${messageType}] ${c.attachment_url}`, messageType, attachmentUrl: c.attachment_url };
  }

  return { body: `[${messageType}]`, messageType };
}

/** Constant-time compare so a wrong token can't be recovered by timing. */
function tokenMatches(candidate: string | null | undefined): boolean {
  if (!candidate || !WEBHOOK_TOKEN) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(WEBHOOK_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Returns null when the caller is authorised, or the response to send back.
 */
function authorise(request: NextRequest): NextResponse | null {
  if (!WEBHOOK_TOKEN) {
    console.warn(
      "[messaging webhook] MSG91_WEBHOOK_TOKEN is not set — accepting unauthenticated callback. Set it to enable verification."
    );
    return null;
  }

  const header = request.headers.get(TOKEN_HEADER);
  const query = new URL(request.url).searchParams.get("token");

  if (tokenMatches(header) || tokenMatches(query)) return null;

  // Never log the supplied value — it is a credential guess.
  console.warn(
    `[messaging webhook] Rejected unauthenticated POST (header ${header ? "present but wrong" : "absent"}, query token ${query ? "present but wrong" : "absent"}).`
  );
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Map MSG91 status strings → our DB status values
const STATUS_MAP: Record<string, string> = {
  DELIVERED:  "delivered",
  READ:       "read",
  FAILED:     "failed",
  SENT:       "sent",
  // lowercase variants (MSG91 can send either)
  delivered:  "delivered",
  read:       "read",
  failed:     "failed",
  sent:       "sent",
};

// ---------------------------------------------------------------------------
// GET — webhook URL verification
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token =
    searchParams.get("token") ??
    searchParams.get("hub.verify_token") ??
    request.headers.get(TOKEN_HEADER);

  if (tokenMatches(token)) {
    // Return the challenge if present (Meta-style) or just 200
    const challenge = searchParams.get("hub.challenge");
    return new Response(challenge ?? "ok", { status: 200 });
  }

  console.warn("[messaging webhook] Verification failed — token mismatch");
  return new Response("Forbidden", { status: 403 });
}

// ---------------------------------------------------------------------------
// POST — delivery status updates + inbound messages
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  // Authenticate before parsing or touching the database.
  const unauthorised = authorise(request);
  if (unauthorised) return unauthorised;

  let body: Record<string, unknown>;

  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = await createAdminClient();

  // MSG91 sends individual objects, not arrays
  // Handle both single-event and batched array formats
  const events: Array<Record<string, unknown>> = Array.isArray(body)
    ? body as Array<Record<string, unknown>>
    : [body];

  for (const event of events) {
    const requestId = event.requestId as string | undefined;
    // WhatsApp delivery reports put the real status string in `status`
    // ("DELIVERED"/"read"/...). The SMS custom-webhook template instead sends
    // a numeric code in `status` (e.g. "1") and puts the actual event name in
    // `upperCaseEventName`/`eventName`/`event` — checking those first (and
    // falling back to `status` for WhatsApp) covers both shapes.
    const rawStatus =
      (event.upperCaseEventName as string | undefined) ??
      (event.eventName as string | undefined) ??
      (event.event as string | undefined) ??
      (event.status as string | undefined);
    // Inbound events populate both `from` and `customerNumber`; prefer whichever
    // is present so a payload that only carries one is still attributed.
    const senderNumber =
      (event.from as string | undefined) || (event.customerNumber as string | undefined);

    const mappedStatus = rawStatus ? STATUS_MAP[rawStatus] : undefined;

    if (requestId && mappedStatus && ["delivered", "read", "failed"].includes(mappedStatus)) {
      // Update existing outbound message status
      const { data: msg } = await supabase
        .from("whatsapp_messages")
        .update({ status: mappedStatus, updated_at: new Date().toISOString() })
        .eq("wa_message_id", requestId)
        .select("id, channel, template_name, to_number, entity_type, entity_id")
        .single();

      // Log delivery confirmation to audit trail + lead activity
      if (msg) {
        const statusLabel = mappedStatus === "delivered" ? "Delivered" : mappedStatus === "read" ? "Read" : "Failed";
        const channelLabel = msg.channel === "sms" ? "SMS" : "WhatsApp";

        // Audit trail — linked to the entity that triggered the message
        if (msg.entity_type && msg.entity_id) {
          await supabase.from("audit_trail").insert({
            entity_type: msg.entity_type,
            entity_id: msg.entity_id,
            action: "update",
            changes: {
              sms_delivery: {
                old: "sent",
                new: `${statusLabel} (${channelLabel} to ${msg.to_number || "unknown"})`,
              },
              template: { old: null, new: msg.template_name || "unknown" },
            },
          }).then(({ error }) => { if (error) console.error("[webhook] audit insert failed:", error.message); });
        }

        // Lead activity — find the lead from the entity
        let leadId: string | null = null;
        if (msg.entity_type === "booking" && msg.entity_id) {
          const { data: booking } = await supabase.from("bookings").select("lead_id").eq("id", msg.entity_id).single();
          leadId = booking?.lead_id || null;
        } else if (msg.entity_type === "billing_statement" && msg.entity_id) {
          const { data: stmt } = await supabase.from("billing_statements").select("lead_id").eq("id", msg.entity_id).single();
          leadId = stmt?.lead_id || null;
        } else if (msg.entity_type === "lead" && msg.entity_id) {
          leadId = msg.entity_id;
        } else if (msg.entity_type === "case" && msg.entity_id) {
          const { data: voCase } = await supabase.from("cases").select("lead_id").eq("id", msg.entity_id).single();
          leadId = voCase?.lead_id || null;
        }

        if (leadId) {
          await supabase.from("activities").insert({
            lead_id: leadId,
            type: "note",
            subject: `${channelLabel} ${statusLabel} — ${msg.template_name || "message"}`,
            description: `${channelLabel} to ${msg.to_number || "unknown"}: ${statusLabel}. Template: ${msg.template_name || "—"}`,
          }).then(({ error }) => { if (error) console.error("[webhook] activity insert failed:", error.message); });
        }
      }
    } else if (senderNumber && !rawStatus) {
      // Inbound message — link to lead if phone matches, log activity, alert dashboard.
      //
      // Not keyed on `text`: most inbound events carry an empty `text` and hold
      // the message inside `content`, so requiring it silently discarded 43 of
      // 51 inbound events, including every Click-to-WhatsApp ad lead. See
      // parseInboundMessage().
      //
      // `!rawStatus` is what separates the two. Delivery reports also carry a
      // `from` (the customer's number), so keying on the sender alone turned
      // every "sent" callback — a status this handler otherwise ignores — into
      // a phantom inbound message. Only delivery reports have a `status` field;
      // inbound events never do.
      const channel = (event.channel as string | undefined) ?? "whatsapp";
      const inboundChannel = channel === "sms" ? "sms" : "whatsapp";

      const { body: messageBody, messageType, referral } = parseInboundMessage(event);

      // Normalise from_number to last 10 digits for fuzzy phone matching
      const digits = senderNumber.replace(/\D/g, "");
      const last10 = digits.slice(-10);

      // Find a matching lead by phone or mobile (suffix match on last 10 digits)
      let matchedLeadId: string | null = null;
      if (last10.length === 10) {
        const { data: leads } = await supabase
          .from("leads")
          .select("id, phone, mobile")
          .or(`phone.ilike.%${last10},mobile.ilike.%${last10}`)
          .limit(1);
        matchedLeadId = leads?.[0]?.id ?? null;
      }

      // Insert inbound message record
      await supabase.from("whatsapp_messages").insert({
        direction:    "inbound",
        channel:      inboundChannel,
        from_number:  senderNumber,
        message_body: messageBody,
        template_name: messageType === "text" ? null : messageType,
        status:       "delivered",
        entity_type:  matchedLeadId ? "lead" : null,
        entity_id:    matchedLeadId ?? null,
      });

      // An ad reply is a fresh inbound lead — surface where it came from, since
      // the number often won't match any existing lead.
      if (referral) {
        console.info(
          `[messaging webhook] Inbound ${referral.sourceType ?? "ad"} reply from ${last10 ? "…" + last10.slice(-4) : "unknown"}` +
          `${referral.headline ? ` (ad: ${referral.headline})` : ""}${matchedLeadId ? "" : " — no matching lead"}`
        );
      }

      // Log activity on the lead timeline so the team can see the reply
      if (matchedLeadId) {
        const adNote = referral
          ? ` (via ${referral.sourceType ?? "ad"}${referral.headline ? `: ${referral.headline}` : ""})`
          : "";
        await supabase.from("activities").insert({
          lead_id:     matchedLeadId,
          type:        "note",
          subject:     `WhatsApp reply received`,
          description: `Customer replied via WhatsApp from ${senderNumber}${adNote}: "${messageBody.substring(0, 200)}${messageBody.length > 200 ? "…" : ""}"`,
        }).then(({ error }) => {
          if (error) console.error("[webhook] inbound activity insert failed:", error.message);
        });
      }
    } else {
      // Neither a delivery report nor something with a sender we can attribute.
      // Log the KEYS only — never the values, which carry customer phone
      // numbers and message text.
      console.warn(
        "[messaging webhook] Unhandled event shape. Top-level keys:",
        Object.keys(event).join(","),
        "| status:", rawStatus ?? "-",
        "| hasRequestId:", !!requestId
      );
    }
  }

  // Always respond 200 — MSG91 retries on non-200
  return NextResponse.json({ status: "ok" });
}

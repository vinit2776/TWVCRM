/**
 * MSG91 Messaging Webhook
 *
 * Receives delivery status callbacks for both WhatsApp and SMS sent via MSG91.
 *
 * GET  — Simple token verification (used when registering the webhook URL in MSG91)
 * POST — Delivery status updates from MSG91
 *
 * Register at:
 *   MSG91 Dashboard → Settings → Webhooks
 *   Callback URL: https://<your-domain>/api/webhooks/whatsapp
 *   Token:        <MSG91_WEBHOOK_TOKEN env var>
 *
 * MSG91 POST body (WhatsApp delivery report):
 *   { "requestId": "...", "status": "DELIVERED"|"READ"|"FAILED", "to": "91...", "channel": "whatsapp" }
 *
 * MSG91 POST body (SMS delivery report):
 *   { "requestId": "...", "status": "DELIVERED"|"FAILED", "to": "91...", "channel": "sms" }
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

const WEBHOOK_TOKEN = process.env.MSG91_WEBHOOK_TOKEN;

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
  const token = searchParams.get("token") ?? searchParams.get("hub.verify_token");

  if (token && token === WEBHOOK_TOKEN) {
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
    const rawStatus = event.status as string | undefined;
    const fromNumber = event.from as string | undefined;
    const text = event.text as string | undefined;

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
    } else if (fromNumber && text) {
      // Inbound message — log it for potential future auto-reply handling
      const channel = (event.channel as string | undefined) ?? "whatsapp";
      await supabase.from("whatsapp_messages").insert({
        direction:    "inbound",
        channel:      channel === "sms" ? "sms" : "whatsapp",
        from_number:  fromNumber,
        message_body: text,
        status:       "delivered",
      });
    }
  }

  // Always respond 200 — MSG91 retries on non-200
  return NextResponse.json({ status: "ok" });
}

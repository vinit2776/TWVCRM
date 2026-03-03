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
      await supabase
        .from("whatsapp_messages")
        .update({ status: mappedStatus, updated_at: new Date().toISOString() })
        .eq("wa_message_id", requestId);
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

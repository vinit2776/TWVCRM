/**
 * WhatsApp Cloud API Webhook
 *
 * GET  — Meta's verification handshake (called once when you register the webhook)
 * POST — Incoming messages + delivery status updates from Meta
 *
 * Register this at:
 *   Meta Developer Portal → Your App → WhatsApp → Configuration → Webhook
 *   Callback URL:  https://<your-domain>/api/webhooks/whatsapp
 *   Verify Token:  <WHATSAPP_WEBHOOK_TOKEN env var>
 *   Subscriptions: messages
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

const WEBHOOK_TOKEN = process.env.WHATSAPP_WEBHOOK_TOKEN;

// ---------------------------------------------------------------------------
// GET — Meta webhook verification challenge
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const mode      = searchParams.get("hub.mode");
  const token     = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === WEBHOOK_TOKEN) {
    console.log("[whatsapp webhook] Verified successfully");
    return new Response(challenge, { status: 200 });
  }

  console.warn("[whatsapp webhook] Verification failed — token mismatch");
  return new Response("Forbidden", { status: 403 });
}

// ---------------------------------------------------------------------------
// POST — Incoming events from Meta
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;

  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Meta sends a top-level object with an "entry" array
  const entry = (body.entry as Array<Record<string, unknown>>) ?? [];

  const supabase = await createAdminClient();

  for (const e of entry) {
    const changes = (e.changes as Array<Record<string, unknown>>) ?? [];

    for (const change of changes) {
      if (change.field !== "messages") continue;

      const value = change.value as Record<string, unknown>;

      // -----------------------------------------------------------------------
      // Status updates (delivered / read / failed)
      // -----------------------------------------------------------------------
      const statuses = (value.statuses as Array<Record<string, unknown>>) ?? [];
      for (const s of statuses) {
        const waId   = s.id as string;
        const status = s.status as string;

        if (!waId || !["delivered", "read", "failed"].includes(status)) continue;

        await supabase
          .from("whatsapp_messages")
          .update({ status, updated_at: new Date().toISOString() })
          .eq("wa_message_id", waId);
      }

      // -----------------------------------------------------------------------
      // Inbound messages — log them; extend here to trigger auto-replies
      // -----------------------------------------------------------------------
      const messages = (value.messages as Array<Record<string, unknown>>) ?? [];
      for (const msg of messages) {
        const from = msg.from as string;
        const text = (msg.text as Record<string, string> | undefined)?.body ?? "";

        await supabase.from("whatsapp_messages").insert({
          direction:    "inbound",
          from_number:  from,
          message_body: text,
          status:       "delivered",
        });
      }
    }
  }

  // Always acknowledge with 200 — Meta retries on non-200 responses
  return NextResponse.json({ status: "ok" });
}

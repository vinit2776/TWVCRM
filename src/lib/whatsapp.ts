/**
 * WhatsApp Business API sender utility.
 * Uses Meta Cloud API (direct) — no BSP required.
 *
 * Required env vars (add to Vercel + .env.local):
 *   WHATSAPP_PHONE_ID       — Phone Number ID from Meta Developer Portal
 *                             (WhatsApp → API Setup → Phone Number ID)
 *   WHATSAPP_ACCESS_TOKEN   — Permanent System User access token
 *                             (App Dashboard → Business Settings → System Users → Generate token)
 *                             Scopes: whatsapp_business_messaging, whatsapp_business_management
 *   WHATSAPP_WEBHOOK_TOKEN  — Any secret string you choose (used for webhook verification)
 *
 * Setup guide:
 *   1. developers.facebook.com → Create App → Business type
 *   2. Add Product → WhatsApp → Set up
 *   3. WhatsApp → API Setup → note Phone Number ID and generate temp token for testing
 *   4. Business Settings → System Users → create system user → generate permanent token
 *   5. Set WHATSAPP_PHONE_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_WEBHOOK_TOKEN in Vercel env
 *   6. Register webhook: App Dashboard → WhatsApp → Configuration → Webhook
 *      Callback URL: https://<your-domain>/api/webhooks/whatsapp
 *      Verify Token: <WHATSAPP_WEBHOOK_TOKEN>
 *      Subscribe to: messages
 */

import { createAdminClient } from "@/lib/supabase/server";

const PHONE_ID    = process.env.WHATSAPP_PHONE_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

function getApiBase() {
  if (!PHONE_ID) {
    console.warn("[whatsapp] WHATSAPP_PHONE_ID is not set — WhatsApp sending disabled.");
    return null;
  }
  if (!ACCESS_TOKEN) {
    console.warn("[whatsapp] WHATSAPP_ACCESS_TOKEN is not set — WhatsApp sending disabled.");
    return null;
  }
  return `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;
}

export interface SendTemplateOptions {
  /** Recipient phone in any format — digits are stripped automatically. India numbers without country code get 91 prepended. */
  to: string;
  /** Approved template name (snake_case as registered in Meta Business Manager) */
  template: string;
  /** Body variable replacements in order — e.g. ["Vinit", "BK-001", "5 March"] */
  params?: string[];
  /** Entity type for message log: 'lead' | 'booking' | 'billing_statement' */
  entityType?: string;
  /** UUID of the related entity */
  entityId?: string;
}

/**
 * Normalises a phone number to E.164 without the leading +.
 * Examples: "9876543210" → "919876543210", "+91 98765 43210" → "919876543210"
 */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // Prepend India country code if 10 digits and starts with 6/7/8/9
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `91${digits}`;
  }
  // Strip leading +
  return digits;
}

/**
 * Sends a WhatsApp template message and logs it to the whatsapp_messages table.
 * Returns the Meta API response (safe to ignore — errors are logged, not thrown).
 */
export async function sendTemplate(options: SendTemplateOptions): Promise<Record<string, unknown>> {
  const { to, template, params = [], entityType, entityId } = options;

  const base = getApiBase();
  if (!base) return { error: "WhatsApp not configured" };

  const toNumber = normalisePhone(to);

  const body = {
    messaging_product: "whatsapp",
    to: toNumber,
    type: "template",
    template: {
      name: template,
      language: { code: "en" },
      components: params.length
        ? [
            {
              type: "body",
              parameters: params.map((text) => ({ type: "text", text })),
            },
          ]
        : [],
    },
  };

  let json: Record<string, unknown> = {};
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    json = await res.json() as Record<string, unknown>;
  } catch (err) {
    console.error("[whatsapp] Network error sending template:", err);
    json = { error: String(err) };
  }

  // Log to DB (fire-and-forget — never throws)
  try {
    const supabase = await createAdminClient();
    const messages = json.messages as Array<{ id: string }> | undefined;
    await supabase.from("whatsapp_messages").insert({
      wa_message_id: messages?.[0]?.id ?? null,
      direction: "outbound",
      to_number: toNumber,
      template_name: template,
      status: json.error ? "failed" : "sent",
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      error_message: json.error ? JSON.stringify(json.error) : null,
    });
  } catch (dbErr) {
    console.error("[whatsapp] Failed to log message to DB:", dbErr);
  }

  return json;
}

/**
 * Convenience wrappers for the four core templates.
 * Add params in the order they appear in the approved template body.
 */

export const whatsapp = {
  /** Booking confirmation → guest */
  bookingConfirmation(to: string, guestName: string, bookingNumber: string, date: string, bookingId: string) {
    return sendTemplate({
      to,
      template: "booking_confirmation",
      params: [guestName, bookingNumber, date],
      entityType: "booking",
      entityId: bookingId,
    });
  },

  /** Billing statement ready → customer */
  billingStatementReady(to: string, customerName: string, statementNumber: string, amount: string, statementId: string) {
    return sendTemplate({
      to,
      template: "billing_statement_ready",
      params: [customerName, statementNumber, amount],
      entityType: "billing_statement",
      entityId: statementId,
    });
  },

  /** Payment reminder → customer */
  paymentReminder(to: string, invoiceNumber: string, amount: string, dueDate: string, statementId: string) {
    return sendTemplate({
      to,
      template: "payment_reminder",
      params: [invoiceNumber, amount, dueDate],
      entityType: "billing_statement",
      entityId: statementId,
    });
  },

  /** Internal new lead alert → staff WhatsApp */
  internalNewLead(staffPhone: string, leadName: string, company: string, source: string, leadId: string) {
    return sendTemplate({
      to: staffPhone,
      template: "internal_new_lead",
      params: [leadName, company, source],
      entityType: "lead",
      entityId: leadId,
    });
  },
};

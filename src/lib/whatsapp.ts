/**
 * Messaging utility — WhatsApp + SMS via MSG91 (CPaaS).
 *
 * MSG91 acts as a WhatsApp BSP (no Facebook account required from your side).
 * SMS is sent as a fallback when WhatsApp delivery fails.
 *
 * Required env vars (add to Vercel + .env.local):
 *   MSG91_AUTH_KEY          — API key (MSG91 dashboard → Settings → API Keys)
 *   MSG91_WHATSAPP_SENDER   — 10-digit WhatsApp sender number registered in MSG91
 *   MSG91_SMS_SENDER_ID     — 6-char DLT-approved sender ID (e.g., TWVCRM)
 *   MSG91_SMS_FLOW_BOOKING  — Flow ID for booking confirmation SMS template
 *   MSG91_SMS_FLOW_BILLING  — Flow ID for billing statement ready SMS template
 *   MSG91_SMS_FLOW_REMINDER — Flow ID for payment reminder SMS template
 *   MSG91_WEBHOOK_TOKEN     — Secret for webhook verification
 *
 * MSG91 Setup:
 *   1. Sign up at msg91.com
 *   2. WhatsApp section → connect WhatsApp Business number → create 4 templates (Utility)
 *   3. SMS section → register sender ID with DLT → create flows → copy flow IDs
 *   4. Settings → API Keys → generate auth key
 *   5. Add webhook: https://<domain>/api/webhooks/whatsapp
 *
 * Templates to create in MSG91 dashboard (all Utility category):
 *   booking_confirmation   — "Hi {{1}}, your booking {{2}} is confirmed for {{3}}. – TWV"
 *   billing_statement_ready — "Hi {{1}}, your billing statement {{2}} for {{3}} is ready. – TWV"
 *   payment_reminder       — "Reminder: Invoice {{1}} for {{2}} is due on {{3}}. – TWV"
 *   internal_new_lead      — "New lead: {{1}} ({{2}}). Source: {{3}}. Open CRM to follow up."
 */

import { createAdminClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTH_KEY      = process.env.MSG91_AUTH_KEY;
const WA_SENDER     = process.env.MSG91_WHATSAPP_SENDER;

const WA_API_URL    = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";
const SMS_API_URL   = "https://control.msg91.com/api/v5/flow/";

// SMS flow IDs (created in MSG91 dashboard after DLT registration)
const SMS_FLOWS = {
  booking:  process.env.MSG91_SMS_FLOW_BOOKING,
  billing:  process.env.MSG91_SMS_FLOW_BILLING,
  reminder: process.env.MSG91_SMS_FLOW_REMINDER,
} as const;

// ---------------------------------------------------------------------------
// Phone normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a phone number to E.164 digits (no leading +).
 * Examples: "9876543210" → "919876543210", "+91 98765 43210" → "919876543210"
 */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  return digits;
}

// ---------------------------------------------------------------------------
// DB logging helper
// ---------------------------------------------------------------------------

async function logMessage(opts: {
  waMessageId?: string | null;
  channel: "whatsapp" | "sms";
  direction: "outbound" | "inbound";
  toNumber?: string;
  fromNumber?: string;
  templateName?: string;
  messageBody?: string;
  status: "sent" | "delivered" | "read" | "failed";
  entityType?: string;
  entityId?: string;
  errorMessage?: string;
}) {
  try {
    const supabase = await createAdminClient();
    await supabase.from("whatsapp_messages").insert({
      wa_message_id:  opts.waMessageId  ?? null,
      channel:        opts.channel,
      direction:      opts.direction,
      to_number:      opts.toNumber     ?? null,
      from_number:    opts.fromNumber   ?? null,
      template_name:  opts.templateName ?? null,
      message_body:   opts.messageBody  ?? null,
      status:         opts.status,
      entity_type:    opts.entityType   ?? null,
      entity_id:      opts.entityId     ?? null,
      error_message:  opts.errorMessage ?? null,
    });
  } catch (err) {
    console.error("[messaging] DB log failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SendTemplateOptions {
  /** Recipient phone — any format, auto-normalised to E.164 */
  to: string;
  /** Approved template name as registered in MSG91 */
  template: string;
  /** Body variable values in order: ["Vinit", "BK-001", "5 March"] */
  params?: string[];
  /** 'lead' | 'booking' | 'billing_statement' */
  entityType?: string;
  entityId?: string;
}

export interface SendResult {
  success: boolean;
  requestId?: string;
  error?: string;
  channel: "whatsapp" | "sms";
}

// ---------------------------------------------------------------------------
// WhatsApp via MSG91
// ---------------------------------------------------------------------------

export async function sendWhatsApp(options: SendTemplateOptions): Promise<SendResult> {
  const { to, template, params = [], entityType, entityId } = options;

  if (!AUTH_KEY || !WA_SENDER) {
    console.warn("[messaging] MSG91_AUTH_KEY or MSG91_WHATSAPP_SENDER not set — WhatsApp disabled.");
    return { success: false, error: "WhatsApp not configured", channel: "whatsapp" };
  }

  const toNumber = normalisePhone(to);

  // Build MSG91 component map: body_1, body_2, ...
  const components: Record<string, { type: string; value: string }> = {};
  params.forEach((value, i) => {
    components[`body_${i + 1}`] = { type: "text", value };
  });

  const payload = {
    integrated_number: WA_SENDER,
    content_type: "template",
    payload: {
      type: "template",
      template: {
        name: template,
        language: { code: "en", policy: "deterministic" },
        to_and_components: [{ to: [toNumber], components }],
      },
      messaging_product: "whatsapp",
    },
  };

  let result: SendResult = { success: false, error: "Unknown error", channel: "whatsapp" };

  try {
    const res = await fetch(WA_API_URL, {
      method: "POST",
      headers: {
        authkey: AUTH_KEY,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json() as Record<string, unknown>;

    if (json.hasError === false || json.status === "success") {
      result = { success: true, requestId: json.request_id as string, channel: "whatsapp" };
    } else {
      result = { success: false, error: JSON.stringify(json.errors ?? json), channel: "whatsapp" };
    }
  } catch (err) {
    console.error("[messaging] WhatsApp network error:", err);
    result = { success: false, error: String(err), channel: "whatsapp" };
  }

  await logMessage({
    waMessageId:  result.requestId,
    channel:      "whatsapp",
    direction:    "outbound",
    toNumber,
    templateName: template,
    status:       result.success ? "sent" : "failed",
    entityType,
    entityId,
    errorMessage: result.error,
  });

  return result;
}

// ---------------------------------------------------------------------------
// SMS via MSG91 Flow API (fallback)
// ---------------------------------------------------------------------------

export async function sendSms(
  flowId: string,
  to: string,
  vars: Record<string, string>,
  opts?: { entityType?: string; entityId?: string; templateName?: string }
): Promise<SendResult> {
  if (!AUTH_KEY) {
    console.warn("[messaging] MSG91_AUTH_KEY not set — SMS disabled.");
    return { success: false, error: "SMS not configured", channel: "sms" };
  }

  const toNumber = normalisePhone(to);

  const payload = {
    flow_id: flowId,
    recipients: [{ mobiles: toNumber, ...vars }],
  };

  let result: SendResult = { success: false, error: "Unknown error", channel: "sms" };

  try {
    const res = await fetch(SMS_API_URL, {
      method: "POST",
      headers: {
        authkey: AUTH_KEY,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json() as Record<string, unknown>;

    if (json.type === "success" || json.status === "success") {
      result = { success: true, requestId: json.request_id as string, channel: "sms" };
    } else {
      result = { success: false, error: JSON.stringify(json), channel: "sms" };
    }
  } catch (err) {
    console.error("[messaging] SMS network error:", err);
    result = { success: false, error: String(err), channel: "sms" };
  }

  await logMessage({
    waMessageId:  result.requestId,
    channel:      "sms",
    direction:    "outbound",
    toNumber,
    templateName: opts?.templateName,
    status:       result.success ? "sent" : "failed",
    entityType:   opts?.entityType,
    entityId:     opts?.entityId,
    errorMessage: result.error,
  });

  return result;
}

// ---------------------------------------------------------------------------
// sendTemplate — WhatsApp first, SMS fallback if WhatsApp fails
// ---------------------------------------------------------------------------

export async function sendTemplate(
  options: SendTemplateOptions,
  smsFallback?: { flowId: string; vars: Record<string, string> }
): Promise<SendResult> {
  const waResult = await sendWhatsApp(options);

  if (!waResult.success && smsFallback?.flowId) {
    console.log(`[messaging] WhatsApp failed for ${options.template}, trying SMS fallback`);
    return sendSms(smsFallback.flowId, options.to, smsFallback.vars, {
      entityType:   options.entityType,
      entityId:     options.entityId,
      templateName: options.template,
    });
  }

  return waResult;
}

// ---------------------------------------------------------------------------
// Convenience wrappers — same public API, MSG91 internals
// ---------------------------------------------------------------------------

export const messaging = {
  /**
   * Booking confirmation → guest / booker phone.
   * WhatsApp first, falls back to SMS (MSG91_SMS_FLOW_BOOKING).
   */
  bookingConfirmation(
    to: string,
    guestName: string,
    bookingNumber: string,
    date: string,
    bookingId: string
  ) {
    return sendTemplate(
      { to, template: "booking_confirmation", params: [guestName, bookingNumber, date], entityType: "booking", entityId: bookingId },
      SMS_FLOWS.booking
        ? { flowId: SMS_FLOWS.booking, vars: { var1: guestName, var2: bookingNumber, var3: date } }
        : undefined
    );
  },

  /**
   * Billing statement ready → customer phone.
   * WhatsApp first, falls back to SMS (MSG91_SMS_FLOW_BILLING).
   */
  billingStatementReady(
    to: string,
    customerName: string,
    statementNumber: string,
    amount: string,
    statementId: string
  ) {
    return sendTemplate(
      { to, template: "billing_statement_ready", params: [customerName, statementNumber, amount], entityType: "billing_statement", entityId: statementId },
      SMS_FLOWS.billing
        ? { flowId: SMS_FLOWS.billing, vars: { var1: customerName, var2: statementNumber, var3: amount } }
        : undefined
    );
  },

  /**
   * Payment reminder → customer phone.
   * WhatsApp first, falls back to SMS (MSG91_SMS_FLOW_REMINDER).
   */
  paymentReminder(
    to: string,
    invoiceNumber: string,
    amount: string,
    dueDate: string,
    statementId: string
  ) {
    return sendTemplate(
      { to, template: "payment_reminder", params: [invoiceNumber, amount, dueDate], entityType: "billing_statement", entityId: statementId },
      SMS_FLOWS.reminder
        ? { flowId: SMS_FLOWS.reminder, vars: { var1: invoiceNumber, var2: amount, var3: dueDate } }
        : undefined
    );
  },

  /**
   * Internal new lead alert → each staff member's WhatsApp.
   * No SMS fallback for internal messages.
   */
  internalNewLead(
    staffPhone: string,
    leadName: string,
    company: string,
    source: string,
    leadId: string
  ) {
    return sendWhatsApp({
      to: staffPhone,
      template: "internal_new_lead",
      params: [leadName, company, source],
      entityType: "lead",
      entityId: leadId,
    });
  },
};

// Keep the old `whatsapp` export alias for any future call sites
export const whatsapp = messaging;

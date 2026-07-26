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
 *   access_denied          — "Hi {{1}}, your access at {{2}} was denied at {{4}} (Reason: {{3}}). Please contact us if you need help. – The Work Villa"
 */

import { createAdminClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Reads an env var and strips surrounding whitespace.
 *
 * Vercel stores whatever was pasted into the dashboard, newline included.
 * A trailing "\n" on MSG91_WHATSAPP_SENDER made every outbound WhatsApp call
 * fail with "WhatsApp not integrated: 917200001638\n" because the integrated
 * number is matched as an exact string on MSG91's side. Trim on read so a
 * stray newline can never take the channel down again.
 */
function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

const AUTH_KEY      = envStr("MSG91_AUTH_KEY");
const WA_SENDER     = envStr("MSG91_WHATSAPP_SENDER");

// SMS is disabled until DLT sender ID is approved on TRAI portal.
// Set MSG91_SMS_ENABLED=true in Vercel env vars to re-enable.
const SMS_ENABLED   = envStr("MSG91_SMS_ENABLED") === "true";

const WA_API_URL    = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";
const SMS_API_URL   = "https://control.msg91.com/api/v5/flow/";

// SMS flow IDs — must match MSG91_SMS_DLT_FLOW_* env vars set in Vercel
// Only used when SMS_ENABLED is true.
const SMS_FLOWS = {
  booking:  SMS_ENABLED ? envStr("MSG91_SMS_DLT_FLOW_BOOKING")          : undefined,
  billing:  undefined as string | undefined, // no billing-specific DLT SMS flow
  reminder: SMS_ENABLED ? envStr("MSG91_SMS_DLT_FLOW_PAYMENT_REMINDER") : undefined,
};

// ---------------------------------------------------------------------------
// DLT SMS Configuration (Jio TrueConnect)
// ---------------------------------------------------------------------------

const DLT_PE_ID     = "1201177261686683603";
const DLT_SENDER    = envStr("MSG91_SMS_SENDER_ID") || "TWVLLA";

/**
 * DLT-registered template IDs (Jio TrueConnect).
 * The message body MUST match the registered template exactly —
 * only {#var#} portions are replaced. Even an extra space causes rejection.
 */
const DLT_TEMPLATES = {
  otp:              { id: "1207177381203939088", vars: 1 },
  booking:          { id: "1207177381893627534", vars: 2 },
  contract_welcome: { id: "1207177381491417204", vars: 2 },
  contract_renewal: { id: "1207177381386366257", vars: 2 },
  payment_reminder: { id: "1207177381025319964", vars: 2 },
  payment_followup: { id: "1207177381424325525", vars: 2 },
  /**
   * Template to register in MSG91 (TRAI DLT approval required):
   * Name: TWV_Access_PIN
   * Body (exact): "Dear {#var#}, your door access PIN for booking {#var#} at The Work Villa is {#var#}. Valid for your booking slot only. -Sree Design Infrastructure"
   * Variables: 3 (guest name, booking ref, PIN)
   *
   * Status: MSG91 flow ID set (6a117c270836a9277c0968a2). Awaiting TRAI DLT
   * template approval — once approved, MSG91 activates the flow automatically.
   * No code change needed when it's approved.
   */
  access_pin:       { id: "", vars: 3 }, // TRAI DLT template ID — to be filled once TRAI approves
} as const;

type DltTemplateKey = keyof typeof DLT_TEMPLATES;

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

export interface SendDocumentOptions {
  /** Recipient phone — any format, auto-normalised to E.164 */
  to: string;
  /**
   * Approved MSG91 template name. The template must have been created with a
   * "Document" header type in the Meta Business Manager / MSG91 dashboard.
   *
   * Templates needed (create in MSG91 → WhatsApp → Templates):
   *   proposal_send_doc        — Header: Document | Body: "Hi {{1}}, please find the proposal {{2}} from The Work Villa."
   *   booking_confirmation_doc — Header: Document | Body: "Hi {{1}}, your proposal {{2}} has been accepted. Please pay the security deposit of Rs.{{3}} here: {{4}} to confirm your booking."
   *   gst_invoice_doc          — Header: Document | Body: "Hi {{1}}, invoice {{2}} of Rs.{{3}} from The Work Villa is attached. Click to pay: {{4}}. Thank you!"
   */
  template: string;
  /** Public URL of the PDF document that MSG91/WhatsApp will fetch and deliver */
  documentUrl: string;
  /** Filename shown to the recipient (e.g. "TWV-2025-001.pdf") */
  documentFilename: string;
  /** Body variable values in order — maps to body_1, body_2, ... */
  params?: string[];
  /**
   * Named body params for templates that use named variables (e.g. {{customer_name}}).
   * Key must match the MSG91 component key exactly (e.g. "body_customer_name").
   * Takes precedence over `params` when provided.
   */
  namedParams?: Record<string, string>;
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
      // Prefix the HTTP status — MSG91 returns 200 for template/param errors but
      // 4xx for auth and integrated-number problems, and the two need different fixes.
      result = { success: false, error: `HTTP ${res.status}: ${JSON.stringify(json.errors ?? json)}`, channel: "whatsapp" };
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
// WhatsApp document template via MSG91
// ---------------------------------------------------------------------------

/**
 * Sends a WhatsApp template message that has a Document header.
 * The template must be created in MSG91 with header_type = "document".
 *
 * MSG91 component map for document templates:
 *   "header" → { type: "document", document: { link, filename } }
 *   "body_N" → { type: "text", value }
 */
export async function sendWhatsAppDocument(options: SendDocumentOptions): Promise<SendResult> {
  const { to, template, documentUrl, documentFilename, params = [], namedParams, entityType, entityId } = options;

  if (!AUTH_KEY || !WA_SENDER) {
    console.warn("[messaging] MSG91_AUTH_KEY or MSG91_WHATSAPP_SENDER not set — WhatsApp disabled.");
    return { success: false, error: "WhatsApp not configured", channel: "whatsapp" };
  }

  const toNumber = normalisePhone(to);

  // MSG91 expects "header_1" as the document header component key,
  // with "value" for the URL and "filename" as a sibling field.
  // Body variables use either named keys (e.g. "body_customer_name") or
  // positional keys (e.g. "body_1") depending on how the template was created.
  const components: Record<string, unknown> = {
    header_1: {
      type: "document",
      value: documentUrl,
      filename: documentFilename,
    },
  };

  if (namedParams) {
    // Named variables — keys must match exactly what MSG91 shows in Template Code panel
    Object.entries(namedParams).forEach(([key, value]) => {
      components[key] = { type: "text", value };
    });
  } else {
    // Positional variables — body_1, body_2, ...
    params.forEach((value, i) => {
      components[`body_${i + 1}`] = { type: "text", value };
    });
  }

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
      // Prefix the HTTP status — MSG91 returns 200 for template/param errors but
      // 4xx for auth and integrated-number problems, and the two need different fixes.
      result = { success: false, error: `HTTP ${res.status}: ${JSON.stringify(json.errors ?? json)}`, channel: "whatsapp" };
    }
  } catch (err) {
    console.error("[messaging] WhatsApp document network error:", err);
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
  if (!SMS_ENABLED) {
    console.info("[messaging] SMS disabled (MSG91_SMS_ENABLED not set) — skipping SMS send.");
    return { success: false, error: "SMS disabled", channel: "sms" };
  }
  if (!AUTH_KEY) {
    console.warn("[messaging] MSG91_AUTH_KEY not set — SMS disabled.");
    return { success: false, error: "SMS not configured", channel: "sms" };
  }

  const toNumber = normalisePhone(to);

  const payload = {
    flow_id: flowId,
    sender: DLT_SENDER,
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
      // The Flow API returns the request ID in `message`, not `request_id`
      // (unlike the WhatsApp API). Without this fallback every SMS row is
      // stored with a null wa_message_id, so the delivery-report webhook can
      // never match it and the status is stuck at "sent" forever.
      const requestId = (json.request_id ?? json.message) as string | undefined;
      result = { success: true, requestId, channel: "sms" };
    } else {
      result = { success: false, error: `HTTP ${res.status}: ${JSON.stringify(json)}`, channel: "sms" };
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
// DLT SMS via MSG91 — exact-match registered templates
// ---------------------------------------------------------------------------

/**
 * Send a DLT-compliant SMS using MSG91 Flow API.
 * The message body is built from the registered template with variables
 * substituted in order. MSG91 requires a Flow per DLT template — set the
 * corresponding MSG91_SMS_FLOW_* env var, or pass `flowId` directly.
 */
export async function sendDltSms(
  templateKey: DltTemplateKey,
  to: string,
  variables: string[],
  opts?: { flowId?: string; entityType?: string; entityId?: string }
): Promise<SendResult> {
  if (!SMS_ENABLED) {
    console.info("[messaging] SMS disabled (MSG91_SMS_ENABLED not set) — skipping DLT SMS send.");
    return { success: false, error: "SMS disabled", channel: "sms" };
  }
  if (!AUTH_KEY) {
    console.warn("[messaging] MSG91_AUTH_KEY not set — DLT SMS disabled.");
    return { success: false, error: "SMS not configured", channel: "sms" };
  }

  const tpl = DLT_TEMPLATES[templateKey];
  if (variables.length !== tpl.vars) {
    console.error(`[messaging] DLT template "${templateKey}" expects ${tpl.vars} variable(s), got ${variables.length}`);
    return { success: false, error: `Variable count mismatch: expected ${tpl.vars}`, channel: "sms" };
  }

  // Guard: TRAI DLT template ID is empty — template not yet approved by TRAI.
  // Sending without approval causes MSG91 to return 400. Skip gracefully.
  if (!tpl.id) {
    console.warn(`[messaging] DLT template "${templateKey}" has no TRAI template ID — skipping until approved.`);
    return { success: false, error: `DLT template "${templateKey}" awaiting TRAI approval`, channel: "sms" };
  }

  const toNumber = normalisePhone(to);

  // Build variable map: VAR1, VAR2, ... (MSG91 flow variable convention)
  const vars: Record<string, string> = {};
  variables.forEach((v, i) => { vars[`VAR${i + 1}`] = v; });

  // Determine which Flow ID to use
  const flowId = opts?.flowId || SMS_DLT_FLOWS[templateKey];
  if (!flowId) {
    console.warn(`[messaging] No MSG91 flow ID configured for DLT template "${templateKey}". Set MSG91_SMS_DLT_FLOW_${templateKey.toUpperCase()} env var.`);
    return { success: false, error: `No flow ID for template "${templateKey}"`, channel: "sms" };
  }

  const payload = {
    flow_id: flowId,
    sender: DLT_SENDER,
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
      // The Flow API returns the request ID in `message`, not `request_id`
      // (unlike the WhatsApp API). Without this fallback every SMS row is
      // stored with a null wa_message_id, so the delivery-report webhook can
      // never match it and the status is stuck at "sent" forever.
      const requestId = (json.request_id ?? json.message) as string | undefined;
      result = { success: true, requestId, channel: "sms" };
    } else {
      result = { success: false, error: `HTTP ${res.status}: ${JSON.stringify(json)}`, channel: "sms" };
    }
  } catch (err) {
    console.error("[messaging] DLT SMS network error:", err);
    result = { success: false, error: String(err), channel: "sms" };
  }

  await logMessage({
    waMessageId:  result.requestId,
    channel:      "sms",
    direction:    "outbound",
    toNumber,
    templateName: `dlt_${templateKey}`,
    messageBody:  `DLT:${tpl.id} PE:${DLT_PE_ID}`,
    status:       result.success ? "sent" : "failed",
    entityType:   opts?.entityType,
    entityId:     opts?.entityId,
    errorMessage: result.error,
  });

  return result;
}

// MSG91 Flow IDs for each DLT template (set in Vercel env vars)
const SMS_DLT_FLOWS: Record<DltTemplateKey, string | undefined> = {
  otp:              envStr("MSG91_SMS_DLT_FLOW_OTP"),
  booking:          envStr("MSG91_SMS_DLT_FLOW_BOOKING")          || SMS_FLOWS.booking,
  contract_welcome: envStr("MSG91_SMS_DLT_FLOW_CONTRACT_WELCOME"),
  contract_renewal: envStr("MSG91_SMS_DLT_FLOW_CONTRACT_RENEWAL"),
  payment_reminder: envStr("MSG91_SMS_DLT_FLOW_PAYMENT_REMINDER") || SMS_FLOWS.reminder,
  payment_followup: envStr("MSG91_SMS_DLT_FLOW_PAYMENT_FOLLOWUP"),
  // Set MSG91_SMS_DLT_FLOW_ACCESS_PIN once the DLT template is TRAI-approved
  access_pin:       envStr("MSG91_SMS_DLT_FLOW_ACCESS_PIN"),
};

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

  /**
   * Check-in confirmation → guest / booker phone.
   * "Hi {{1}}, you're now checked in at {{2}} (Booking #{{3}}). Have a great session! – The Work Villa"
   */
  bookingCheckin(
    to: string,
    guestName: string,
    spaceName: string,
    bookingNumber: string,
    bookingId: string
  ) {
    return sendWhatsApp({
      to,
      template: "booking_checkin",
      params: [guestName, spaceName, bookingNumber],
      entityType: "booking",
      entityId: bookingId,
    });
  },

  /**
   * Check-out confirmation → guest / booker phone.
   * "Hi {{1}}, you've checked out of {{2}} (Booking #{{3}}). Thank you for visiting The Work Villa!"
   */
  bookingCheckout(
    to: string,
    guestName: string,
    spaceName: string,
    bookingNumber: string,
    bookingId: string
  ) {
    return sendWhatsApp({
      to,
      template: "booking_checkout",
      params: [guestName, spaceName, bookingNumber],
      entityType: "booking",
      entityId: bookingId,
    });
  },

  // proposalDepositRequest() and proposalInvoice() were removed. They sent the
  // templates "proposal_deposit_request" and "proposal_invoice", neither of
  // which exists in MSG91 — every call failed with "template name does not
  // exist in en". Their content is covered by the approved document templates
  // below: bookingConfirmationDocument() and invoiceDocument().

  // ── Document (PDF) wrappers ────────────────────────────────────────────────
  // Each requires a matching MSG91 template with a Document header.
  // Create in MSG91 → WhatsApp → Templates (Utility category, Document header).

  /**
   * Proposal PDF → lead phone during negotiation phase.
   * Template: twv_proposal_doc
   * Header: Document  |  Body: "Hi {{customer_name}}, please find attached proposal {{proposal_number}} from The Work Villa."
   */
  proposalDocument(
    to: string,
    customerName: string,
    proposalNumber: string,
    pdfUrl: string,
    proposalId: string
  ) {
    // proposal_send_doc uses named variables {{customer_name}} / {{proposal_number}}
    // so MSG91 component keys are "body_customer_name" / "body_proposal_number"
    return sendWhatsAppDocument({
      to,
      template: "twv_proposal_doc",
      documentUrl: pdfUrl,
      documentFilename: `${proposalNumber}.pdf`,
      namedParams: {
        body_customer_name: customerName,
        body_proposal_number: proposalNumber,
      },
      entityType: "proposal",
      entityId: proposalId,
    });
  },

  /**
   * Booking confirmation PDF → lead phone after acceptance.
   * Template: booking_confirmation_doc
   * Header: Document  |  Body: "Hi {{1}}, your proposal {{2}} has been accepted. Please pay the security deposit of Rs.{{3}} here: {{4}} to confirm your booking."
   */
  bookingConfirmationDocument(
    to: string,
    customerName: string,
    proposalNumber: string,
    depositAmount: string,
    depositLink: string,
    pdfUrl: string,
    proposalId: string
  ) {
    return sendWhatsAppDocument({
      to,
      template: "booking_confirmation_doc",
      documentUrl: pdfUrl,
      documentFilename: `${proposalNumber}-booking.pdf`,
      params: [customerName, proposalNumber, depositAmount, depositLink],
      entityType: "proposal",
      entityId: proposalId,
    });
  },

  /**
   * GST invoice PDF → lead phone.
   * Template: gst_invoice_doc
   * Header: Document  |  Body: "Hi {{1}}, invoice {{2}} of Rs.{{3}} from The Work Villa is attached. Pay here: {{4}}"
   */
  invoiceDocument(
    to: string,
    customerName: string,
    invoiceNumber: string,
    totalAmount: string,
    paymentLink: string,
    pdfUrl: string,
    proposalId: string
  ) {
    return sendWhatsAppDocument({
      to,
      template: "gst_invoice_doc",
      documentUrl: pdfUrl,
      documentFilename: `${invoiceNumber.replace(/\//g, "-")}.pdf`,
      params: [customerName, invoiceNumber, totalAmount, paymentLink],
      entityType: "proposal",
      entityId: proposalId,
    });
  },

  /**
   * Booking access PIN → guest / booker phone via WhatsApp.
   *
   * Template to create in MSG91 → WhatsApp → Templates (Utility category):
   *   Name: booking_access_pin
   *   Body: "Hi {{1}}, your door access PIN for booking {{2}} ({{3}} – {{4}}) at The Work Villa is: *{{5}}*. Use this PIN at the entry and room devices. Valid with a 5-minute buffer. – The Work Villa"
   *
   * Params: [guestName, bookingRef, startTime, endTime, pin]
   */
  bookingAccessPin(
    to: string,
    guestName: string,
    bookingRef: string,
    startTime: string,
    endTime: string,
    pin: string,
    bookingId: string
  ) {
    return sendWhatsApp({
      to,
      template: "booking_access_pin",
      params: [guestName, bookingRef, startTime, endTime, pin],
      entityType: "booking",
      entityId: bookingId,
    });
  },
};

// ---------------------------------------------------------------------------
// DLT SMS convenience wrappers — exact template match required by TRAI
// ---------------------------------------------------------------------------

export const dltSms = {
  /**
   * TWV_OTP_Transactional (1207177381203939088)
   * "Your OTP for The Work Villa is {#var#}. Valid for 10 minutes. Do not share this OTP. -Sree Design Infrastructure"
   */
  otp(to: string, otpCode: string, entityId?: string) {
    return sendDltSms("otp", to, [otpCode], { entityType: "otp", entityId });
  },

  /**
   * TWV_Booking_Confirmation (1207177381893627534)
   * "Dear {#var#}, your booking at The Work Villa is confirmed. Booking Ref: {#var#}. Our team will contact you shortly. -Sree Design Infrastructure"
   */
  bookingConfirmation(to: string, customerName: string, bookingRef: string, bookingId: string) {
    return sendDltSms("booking", to, [customerName, bookingRef], { entityType: "booking", entityId: bookingId });
  },

  /**
   * TWV_Contract_Welcome (1207177381491417204)
   * "Welcome to The Work Villa! Dear {#var#}, your workspace contract commences on {#var#}. We look forward to serving you. -Sree Design Infrastructure"
   */
  contractWelcome(to: string, customerName: string, startDate: string, caseId: string) {
    return sendDltSms("contract_welcome", to, [customerName, startDate], { entityType: "case", entityId: caseId });
  },

  /**
   * TWV_Contract_Renewal (1207177381386366257)
   * "Dear {#var#}, your workspace contract at The Work Villa is due for renewal on {#var#}. Please contact us to renew and continue uninterrupted service. -Sree Design Infrastructure"
   */
  contractRenewal(to: string, customerName: string, renewalDate: string, caseId: string) {
    return sendDltSms("contract_renewal", to, [customerName, renewalDate], { entityType: "case", entityId: caseId });
  },

  /**
   * TWV_Payment_Reminder (1207177381025319964)
   * "Dear {#var#}, your payment of Rs.{#var#} is due for your workspace at The Work Villa. Please pay to avoid disruption. -Sree Design Infrastructure"
   */
  paymentReminder(to: string, customerName: string, amount: string, paymentId: string) {
    return sendDltSms("payment_reminder", to, [customerName, amount], { entityType: "contract_payment", entityId: paymentId });
  },

  /**
   * TWV_Payment_Followup (1207177381424325525)
   * "Dear {#var#}, this is a reminder that your payment of Rs.{#var#} to The Work Villa is overdue. Please settle at the earliest. -Sree Design Infrastructure"
   */
  paymentFollowup(to: string, customerName: string, amount: string, paymentId: string) {
    return sendDltSms("payment_followup", to, [customerName, amount], { entityType: "contract_payment", entityId: paymentId });
  },

  /**
   * TWV_Access_PIN — MSG91 flow wired (6a117c270836a9277c0968a2), TRAI DLT approval pending.
   * Template body: "Dear {#var#}, your door access PIN for booking {#var#} at The Work Villa is {#var#}. Valid for your booking slot only. -Sree Design Infrastructure"
   * Variables: [guestName, bookingRef, pin]
   *
   * Will attempt to send now; MSG91 will activate when TRAI approves the DLT template.
   */
  accessPin(to: string, guestName: string, bookingRef: string, pin: string, bookingId: string) {
    return sendDltSms("access_pin", to, [guestName, bookingRef, pin], { entityType: "booking", entityId: bookingId });
  },
};

// Keep the old `whatsapp` export alias for any future call sites
export const whatsapp = messaging;

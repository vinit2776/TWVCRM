/**
 * POST /api/admin/test-whatsapp
 * Admin-only: sends a test message through the real messaging library and
 * returns the outcome, so a failure here reproduces exactly what production
 * cron jobs and API routes hit.
 *
 * Body: { to: string, channel?: "whatsapp" | "sms", template?: string, params?: string[] }
 *   to       — recipient phone in any format (auto-normalised to E.164)
 *   channel  — "whatsapp" (default) or "sms" (DLT flow)
 *   template — WhatsApp template name, or DLT template key when channel = "sms"
 *   params   — override the sample body variables
 *
 * GET — config health check (no message sent). Flags env vars that carry
 * stray whitespace, which silently breaks MSG91 calls.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsApp, sendDltSms } from "@/lib/whatsapp";

// Sample body params per WhatsApp template
const WA_SAMPLE_PARAMS: Record<string, string[]> = {
  booking_confirmation:    ["Test User", "BK-TEST-001", "15 April 2026"],
  billing_statement_ready: ["Test User", "BS-TEST-001", "Rs.5,000"],
  payment_reminder:        ["BS-TEST-001", "Rs.5,000", "20 April 2026"],
  internal_new_lead:       ["Test Lead", "Test Company", "Manual Entry"],
  booking_checkin:         ["Test User", "Meeting Room 1", "BK-TEST-001"],
  booking_checkout:        ["Test User", "Meeting Room 1", "BK-TEST-001"],
  lead_followup_reminder:  ["Test User", "Test Lead", "Manual Entry"],
};

// Sample variables per DLT SMS template key
const SMS_SAMPLE_VARS = {
  otp:              ["123456"],
  booking:          ["Test User", "BK-TEST-001"],
  contract_welcome: ["Test User", "1 August 2026"],
  contract_renewal: ["Test User", "1 August 2026"],
  payment_reminder: ["Test User", "5,000"],
  payment_followup: ["Test User", "5,000"],
} satisfies Record<string, string[]>;

type SmsTemplateKey = keyof typeof SMS_SAMPLE_VARS;

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return { error: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
  }
  return { error: null };
}

export async function POST(request: NextRequest) {
  const { error: authError } = await requireAdmin();
  if (authError) return authError;

  const body = await request.json().catch(() => ({})) as {
    to?: string;
    channel?: string;
    template?: string;
    params?: string[];
  };

  const to = body.to?.trim();
  if (!to) return NextResponse.json({ error: "Field 'to' (phone number) is required" }, { status: 400 });

  const channel = body.channel === "sms" ? "sms" : "whatsapp";

  if (channel === "sms") {
    const key = (body.template ?? "otp") as SmsTemplateKey;
    if (!SMS_SAMPLE_VARS[key]) {
      return NextResponse.json(
        { error: `Unknown DLT template key "${key}"`, available: Object.keys(SMS_SAMPLE_VARS) },
        { status: 400 }
      );
    }
    const vars = body.params ?? SMS_SAMPLE_VARS[key];
    const result = await sendDltSms(key, to, vars, { entityType: "admin_test" });
    return NextResponse.json({ ok: result.success, channel: "sms", template: key, vars, result });
  }

  const template = body.template ?? "booking_confirmation";
  const params = body.params ?? WA_SAMPLE_PARAMS[template] ?? WA_SAMPLE_PARAMS["booking_confirmation"];
  const result = await sendWhatsApp({ to, template, params, entityType: "admin_test" });

  return NextResponse.json({ ok: result.success, channel: "whatsapp", template, params, result });
}

// GET — config health check (no message sent)
export async function GET() {
  const { error: authError } = await requireAdmin();
  if (authError) return authError;

  // Report presence AND cleanliness. A value that differs from its trimmed form
  // is the failure mode that took WhatsApp down: MSG91 matches the integrated
  // number as an exact string, so a trailing newline rejects every send.
  const KEYS = [
    "MSG91_AUTH_KEY",
    "MSG91_WHATSAPP_SENDER",
    "MSG91_WEBHOOK_TOKEN",
    "MSG91_SMS_ENABLED",
    "MSG91_SMS_SENDER_ID",
    "MSG91_SMS_DLT_FLOW_OTP",
    "MSG91_SMS_DLT_FLOW_BOOKING",
    "MSG91_SMS_DLT_FLOW_CONTRACT_WELCOME",
    "MSG91_SMS_DLT_FLOW_CONTRACT_RENEWAL",
    "MSG91_SMS_DLT_FLOW_PAYMENT_REMINDER",
    "MSG91_SMS_DLT_FLOW_PAYMENT_FOLLOWUP",
    "MSG91_SMS_DLT_FLOW_ACCESS_PIN",
    "MSG91_WA_TEMPLATE_FACILITY_NUDGE",
    "MSG91_WA_TEMPLATE_FACILITY_ASSIGNED",
  ];

  const configured: Record<string, { set: boolean; clean: boolean }> = {};
  const dirty: string[] = [];
  for (const key of KEYS) {
    const raw = process.env[key];
    const set = !!raw && raw.trim() !== "";
    const clean = !set || raw === raw!.trim();
    configured[key] = { set, clean };
    if (set && !clean) dirty.push(key);
  }

  const whatsappReady = configured.MSG91_AUTH_KEY.set && configured.MSG91_WHATSAPP_SENDER.set;
  const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL?.trim() ?? ""}/api/webhooks/whatsapp`;

  return NextResponse.json({
    whatsappReady,
    smsEnabled: process.env.MSG91_SMS_ENABLED?.trim() === "true",
    webhookUrl,
    dirtyEnvVars: dirty,
    dirtyEnvHint: dirty.length
      ? "These env vars have leading/trailing whitespace. MSG91 matches these values exactly — re-save them in Vercel without the newline."
      : undefined,
    configured,
    whatsappTemplates: Object.keys(WA_SAMPLE_PARAMS),
    smsTemplates: Object.keys(SMS_SAMPLE_VARS),
  });
}

/**
 * POST /api/admin/test-whatsapp
 * Admin-only: sends a test WhatsApp message and returns the raw MSG91 response.
 * Used to verify the MSG91 connection after credentials are configured.
 *
 * Body: { to: string, template?: string }
 *   to       — recipient phone in any format (auto-normalised to E.164)
 *   template — optional; defaults to "booking_confirmation" with sample params
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const AUTH_KEY  = process.env.MSG91_AUTH_KEY;
const WA_SENDER = process.env.MSG91_WHATSAPP_SENDER;
const WA_API    = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";

function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  return digits;
}

export async function POST(request: NextRequest) {
  // Admin-only guard
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // Check config
  if (!AUTH_KEY || !WA_SENDER) {
    return NextResponse.json({
      ok: false,
      error: "MSG91 not configured",
      missing: [
        !AUTH_KEY  && "MSG91_AUTH_KEY",
        !WA_SENDER && "MSG91_WHATSAPP_SENDER",
      ].filter(Boolean),
      hint: "Add these env vars in Vercel → Project → Settings → Environment Variables, then redeploy.",
    }, { status: 503 });
  }

  const body = await request.json().catch(() => ({})) as { to?: string; template?: string };
  const to = body.to;
  if (!to) return NextResponse.json({ error: "Field 'to' (phone number) is required" }, { status: 400 });

  const template = body.template ?? "booking_confirmation";
  const toNumber = normalisePhone(to);

  // Sample params per template
  const sampleParams: Record<string, string[]> = {
    booking_confirmation:    ["Test User", "BK-TEST-001", "15 April 2026"],
    billing_statement_ready: ["Test User", "BS-TEST-001", "₹5,000"],
    payment_reminder:        ["BS-TEST-001", "₹5,000", "20 April 2026"],
    internal_new_lead:       ["Test Lead", "Test Company", "Manual Entry"],
  };
  const params = sampleParams[template] ?? sampleParams["booking_confirmation"];

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

  try {
    const res = await fetch(WA_API, {
      method: "POST",
      headers: {
        authkey: AUTH_KEY,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json() as Record<string, unknown>;
    const success = json.hasError === false || json.status === "success";

    return NextResponse.json({
      ok: success,
      to: toNumber,
      template,
      sender: WA_SENDER,
      msg91Response: json,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// GET — config health check (no message sent)
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const configured = {
    MSG91_AUTH_KEY:          !!AUTH_KEY,
    MSG91_WHATSAPP_SENDER:   !!WA_SENDER,
    MSG91_WEBHOOK_TOKEN:     !!process.env.MSG91_WEBHOOK_TOKEN,
    MSG91_SMS_SENDER_ID:     !!process.env.MSG91_SMS_SENDER_ID,
    MSG91_SMS_DLT_FLOW_OTP:              !!process.env.MSG91_SMS_DLT_FLOW_OTP,
    MSG91_SMS_DLT_FLOW_BOOKING:          !!process.env.MSG91_SMS_DLT_FLOW_BOOKING,
    MSG91_SMS_DLT_FLOW_CONTRACT_WELCOME: !!process.env.MSG91_SMS_DLT_FLOW_CONTRACT_WELCOME,
    MSG91_SMS_DLT_FLOW_CONTRACT_RENEWAL: !!process.env.MSG91_SMS_DLT_FLOW_CONTRACT_RENEWAL,
    MSG91_SMS_DLT_FLOW_PAYMENT_REMINDER: !!process.env.MSG91_SMS_DLT_FLOW_PAYMENT_REMINDER,
    MSG91_SMS_DLT_FLOW_PAYMENT_FOLLOWUP: !!process.env.MSG91_SMS_DLT_FLOW_PAYMENT_FOLLOWUP,
  };

  const whatsappReady = configured.MSG91_AUTH_KEY && configured.MSG91_WHATSAPP_SENDER;
  const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/webhooks/whatsapp`;

  return NextResponse.json({
    whatsappReady,
    webhookUrl,
    configured,
    templates: [
      { name: "booking_confirmation",    params: 3, trigger: "New booking created" },
      { name: "billing_statement_ready", params: 3, trigger: "Statement finalised" },
      { name: "payment_reminder",        params: 3, trigger: "Manual payment reminder" },
      { name: "internal_new_lead",       params: 3, trigger: "New lead registered" },
    ],
  });
}

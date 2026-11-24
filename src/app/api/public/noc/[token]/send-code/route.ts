import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { loadNocBundle, leadDisplayName } from "@/lib/noc/bundle";
import { clientIp, generateOtp, hashOtp, recordNocEvent } from "@/lib/noc/server";
import { maskEmail, OTP_TTL_MINUTES, otpSendDecision, OTP_SEND_WINDOW_MINUTES } from "@/lib/noc/acceptance";
import { buildCodeEmail } from "@/lib/noc/emails";
import { sendNocEmail } from "@/lib/noc/send";

export const dynamic = "force-dynamic";

/**
 * POST /api/public/noc/[token]/send-code
 * Emails a 6-digit one-time code to the email already on the contract, to prove the person on the page holds it.
 * Rate limited per order. The code is stored only as a hash and is never returned.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,128}$/.test(token)) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  const admin = createAdminClient();
  const b = await loadNocBundle(admin, { token });
  if (!b || !b.noc.invoice_id) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  if (b.noc.status === "void") return NextResponse.json({ error: "This link is no longer active." }, { status: 410 });
  if (b.noc.accepted_at) return NextResponse.json({ error: "The terms are already accepted." }, { status: 409 });

  const to = b.noc.sent_to || b.lead?.email;
  if (!to) return NextResponse.json({ error: "We have no email address on record for this contract. Please contact The WorkVilla." }, { status: 422 });

  const since = new Date(Date.now() - OTP_SEND_WINDOW_MINUTES * 60_000).toISOString();
  const { data: recent } = await admin.from("noc_otp_codes").select("created_at").eq("noc_id", b.noc.id).gte("created_at", since);
  const decision = otpSendDecision((recent ?? []).map((r) => r.created_at), Date.now());
  if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: 429 });

  const code = generateOtp();
  const mail = buildCodeEmail({ code, companyName: b.noc.company_name, minutes: OTP_TTL_MINUTES });
  const sent = await sendNocEmail(admin, { to, subject: mail.subject, html: mail.html });
  if (!sent.ok) {
    await recordNocEvent(admin, b.noc.id, "code_send_failed", { actorLabel: "system", ip: clientIp(req.headers), detail: { to: maskEmail(to), error: sent.error, blocked: !!sent.blocked } });
    return NextResponse.json({ error: sent.blocked ? sent.error : "We could not email the code just now. Please try again in a minute." }, { status: sent.blocked ? 403 : 502 });
  }

  await admin.from("noc_otp_codes").insert({ noc_id: b.noc.id, code_hash: hashOtp(code, b.noc.id), sent_to: to, expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString() });
  await recordNocEvent(admin, b.noc.id, "code_sent", { actorLabel: "system", ip: clientIp(req.headers), userAgent: req.headers.get("user-agent"), detail: { to: maskEmail(to), recipient_name: leadDisplayName(b.lead) } });
  return NextResponse.json({ data: { sentTo: maskEmail(to), minutes: OTP_TTL_MINUTES } });
}

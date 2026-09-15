import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { computeGstAndRounding } from "@/lib/gst-math";

export const maxDuration = 30;

/**
 * GET /api/billing-statements/[id]/preview-send
 *
 * Read-only preview of the email that Finalize & Send (or Send Proforma)
 * will dispatch — same subject line and body copy as dispatchProforma()'s
 * emailHtml in src/lib/send-proforma.ts. Deliberately a separate, hand-kept
 * copy rather than a shared function: dispatchProforma is a single dense
 * function that creates the live Razorpay link inline before building this
 * HTML, and extracting a shared builder would mean touching that dispatch
 * path under this PR just to serve a preview. If the real template changes,
 * update this copy to match.
 *
 * No mutation, no email send, no Razorpay call — a draft has no payment
 * link yet, so this preview omits the Pay Now button/QR and says so, same
 * as the real proforma-pdf preview does.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: statement, error: fetchErr } = await admin
    .from("billing_statements")
    .select(`
      id, statement_number, statement_type, status, voided_at, period_start, due_date,
      fixed_amount, service_usage_amount, booking_usage_amount, tax_percentage, line_items,
      contract_id,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, billing_emails)
      ),
      usage_charges:usage_charges(id, description, quantity, unit_price, total, is_waived)
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (statement.voided_at) return NextResponse.json({ error: "Statement is voided" }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;
  const partyRef: string = contract?.contract_number ?? "";
  const proformaRef = statement.statement_number as string;

  const customerEmail = (lead?.email as string | undefined) || undefined;
  const billingEmails = (lead?.billing_emails as string[] | null) ?? [];
  const toList = Array.from(new Set([customerEmail, ...billingEmails].filter((e): e is string => Boolean(e))));
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";

  // Same subtotal derivation proforma-pdf/send-proforma use — structured
  // line_items when present, else the legacy per-field sum. Ad-hoc charges
  // are the one exception: add-charge/waive-charge never update this frozen
  // line_items snapshot, so the live usage_charges table (filtered to
  // non-waived) is the source of truth for that section — see the matching
  // comment in send-proforma.ts's dispatchProforma().
  const usageCharges = ((statement.usage_charges || []) as { total: number; is_waived: boolean }[])
    .filter((c) => !c.is_waived);
  const usageAmount = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const structuredSections = (statement.line_items || []) as Array<{ type: string; subtotal: number }>;
  const nonAdHocSubtotal = structuredSections.filter((sec) => sec.type !== "ad_hoc_charges").reduce((s, sec) => s + Number(sec.subtotal || 0), 0);
  const subtotal = structuredSections.length > 0
    ? nonAdHocSubtotal + usageAmount
    : fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);
  const { totalAmount } = computeGstAndRounding(subtotal, taxPercentage);

  const periodLabel = new Date((statement.period_start as string) + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "numeric" });
  const introSentence = `Please find attached your proforma invoice for <strong>${periodLabel}</strong>. Kindly make the payment at your earliest convenience.`;

  // A draft may not have a due_date set yet — finalize-and-send stamps
  // today (IST) + 7 days at send time, so preview that same computation.
  let dueDateYmd = statement.due_date as string | null;
  if (!dueDateYmd) {
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    istNow.setUTCDate(istNow.getUTCDate() + 7);
    dueDateYmd = istNow.toISOString().slice(0, 10);
  }
  const dueDateStr = new Date(dueDateYmd + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

  const emailSubject = `Proforma Invoice ${proformaRef} — ${partyRef} — The WorkVilla`;

  const paymentOptionsHtml = `
    <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
    </table>
  `;

  const emailHtml = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Proforma Invoice</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">${introSentence}</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Proforma Ref</td><td style="padding:6px 0;font-weight:600;">${proformaRef}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${partyRef}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Payment Due By</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${dueDateStr}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${Math.round(totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td></tr>
        </table>
        ${paymentOptionsHtml}
        <div style="text-align:center;margin:24px 0 12px;">
          <a href="#" style="background:#f0faf5;color:#015E65;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:13px;border:1px solid #015E65;">View Invoice Online</a>
        </div>
        <div style="text-align:center;margin:12px 0;">
          <a href="#" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;opacity:0.5;">Pay Now</a>
          <p style="color:#888;font-size:11px;margin:8px 0 0;">Payment link is created when this statement is actually sent — not shown in this preview.</p>
        </div>
        <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
        <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:10px 16px;margin-top:24px;font-size:11px;color:#5d4037;">
          ⚠️ This is a proforma invoice for payment purposes only. A formal GST tax invoice will be issued once payment is confirmed.
        </div>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>
  `;

  return NextResponse.json({
    data: {
      subject: emailSubject,
      to: toList,
      bcc: "billing@theworkvilla.com",
      html: emailHtml,
      no_contact: toList.length === 0,
    },
  });
}

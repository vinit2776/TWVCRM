import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";
import { formatCurrency, formatDate } from "@/lib/utils";
import { TDS_CLIENT_SECTIONS } from "@/lib/constants";

/**
 * POST /api/tds/receivable/[paymentId]/chase-certificate
 *
 * Manual-only nudge to a client for their Form 16A. Never automated (no
 * cron) — see tds_certificate_path's comment: the certificate is optional
 * and never required to settle the payment, so chasing it is a judgment
 * call accounts makes per client, not a dunning ladder.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> }
) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or accounts can chase a TDS certificate" }, { status: 403 });
  }

  const { data: payment } = await supabase
    .from("billing_payments")
    .select(`
      id, payment_date, tds_amount, tds_section, tds_certificate_path, certificate_reminder_count,
      billing_statement:billing_statements!billing_payments_billing_statement_id_fkey(
        id, statement_number, gst_invoice_number,
        contract:contracts!billing_statements_contract_id_fkey(
          contract_number,
          lead:leads!contracts_lead_id_fkey(company, first_name, last_name, email, billing_emails)
        )
      )
    `)
    .eq("id", paymentId)
    .single();

  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (!payment.tds_amount || Number(payment.tds_amount) <= 0) {
    return NextResponse.json({ error: "This payment has no TDS deduction to chase" }, { status: 400 });
  }
  if (payment.tds_certificate_path) {
    return NextResponse.json({ error: "Certificate already on file — nothing to chase" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = payment.billing_statement as any;
  const contract = stmt?.contract;
  const lead = contract?.lead;
  const clientName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "our records";
  const recipients: string[] = Array.from(new Set([lead?.email, ...(lead?.billing_emails || [])].filter(Boolean)));

  if (recipients.length === 0) {
    return NextResponse.json({ error: "No email on file for this client — add one before chasing" }, { status: 400 });
  }

  const sectionLabel = TDS_CLIENT_SECTIONS.find((s) => s.code === payment.tds_section)?.description;
  const reference = stmt?.gst_invoice_number || stmt?.statement_number || contract?.contract_number || "your invoice";

  const html = `
    <p>Dear ${clientName},</p>
    <p>We show a TDS deduction of <strong>${formatCurrency(Number(payment.tds_amount))}</strong>
      ${payment.tds_section ? `(Section ${payment.tds_section}${sectionLabel ? ` — ${sectionLabel}` : ""})` : ""}
      on the payment against <strong>${reference}</strong>, dated ${formatDate(payment.payment_date)}.</p>
    <p>Could you please share the Form 16A TDS certificate for this deduction at your earliest convenience?
      This helps us reconcile against Form 26AS.</p>
    <p>Thank you,<br/>The WorkVilla Accounts Team</p>
  `;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: recipients,
      replyTo: EMAIL_REPLY_TO,
      subject: `Request for TDS Certificate (Form 16A) — ${reference}`,
      html,
    });
  } catch (err) {
    console.error("[chase-certificate] send failed:", err);
    return NextResponse.json({ error: "Failed to send the reminder email" }, { status: 502 });
  }

  const newCount = (payment.certificate_reminder_count ?? 0) + 1;
  const sentAt = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("billing_payments")
    .update({ certificate_reminder_count: newCount, last_certificate_reminder_sent_at: sentAt })
    .eq("id", paymentId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: stmt?.id ?? paymentId,
    action: "update",
    performedBy: dbUser.id,
    changes: { certificate_chase_sent: { old: null, new: recipients.join(", ") } },
  });

  return NextResponse.json({
    data: { certificate_reminder_count: newCount, last_certificate_reminder_sent_at: sentAt },
  });
}

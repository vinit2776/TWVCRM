import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { buildPackageStatementPdf, loadPackageStatement } from "@/lib/package-statement-server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "accounts", "sales_rep"];
const bodySchema = z.object({ to: z.string().trim().email() });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * POST /api/prepaid-purchases/[id]/statement/email  { to }
 *
 * Emails the package statement PDF. The address always comes from the caller
 * (the UI shows it for confirmation first), never from the package record.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });

  const admin = createAdminClient();
  const data = await loadPackageStatement(admin, id);
  if (!data) return NextResponse.json({ error: "Package not found" }, { status: 404 });

  const pdf = buildPackageStatementPdf(data);
  const name = escapeHtml(data.party.name);
  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: parsed.data.to,
    replyTo: EMAIL_REPLY_TO,
    subject: `Your ${data.purchase.packageName} statement - The WorkVilla`,
    html: `<p>Dear ${name},</p>
       <p>Please find attached the statement for your <strong>${escapeHtml(data.purchase.packageName)}</strong> package, showing how it has been used. Your current balance is <strong>${data.statement.balance} ${data.statement.unitLabel}</strong>.</p>
       <p>Regards,<br/>The WorkVilla</p>`,
    patient: true,
    attachments: [{
      filename: `Package-Statement-${data.party.name.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`,
      content: pdf,
      contentType: "application/pdf",
    }],
  });
  if (result.error) {
    return NextResponse.json({ error: "Could not send the email: " + result.error.message }, { status: 502 });
  }

  void logAudit(admin, {
    entityType: "prepaid_purchase", entityId: id, action: "update", performedBy: dbUser.id,
    changes: { package_statement: { old: null, new: `emailed to ${parsed.data.to}` } },
  });
  return NextResponse.json({ data: { sent_to: parsed.data.to } });
}

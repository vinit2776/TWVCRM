import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  createRenewalRazorpayLink,
  createRenewalBillingStatement,
  generateRenewalPI,
  sendRenewalEmail,
  renewalRate,
  type VoCaseForRenewal,
} from "@/lib/vo-renewal";
import { renewalRecipients } from "@/lib/renewal-recipients";

const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "accounts"];

const CASE_SELECT =
  "*, location:locations!cases_location_id_fkey(name, address, city, state), " +
  "aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone)";

/**
 * GET  /api/cases/[id]/renewal-notice — who would be told, and what it costs.
 * POST /api/cases/[id]/renewal-notice — actually send it.
 *
 * The deliberate counterpart to the automated cron. Every existing case is
 * renewal_notices_enabled = false (00526) because its expiry was derived by a
 * backfill rather than agreed with anyone — so the cron can never touch them.
 * This route can, because a person is choosing to, having looked at the case.
 *
 * That opt-out is therefore NOT checked here. The gate on this path is the
 * human plus the role check, not the flag.
 */

interface RenewalNoticeBody {
  /** Extra addresses to copy. The routed parties are always included. */
  cc?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadCase(caseId: string) {
  const adminSupabase = await createAdminClient();
  const { data } = await adminSupabase.from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle();
  return { adminSupabase, caseRow: data as unknown as VoCaseForRenewal | null };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { caseRow } = await loadCase(caseId);
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  if (!caseRow.end_date) {
    return NextResponse.json(
      { error: "This case has no end date, so there is no renewal to notify about." },
      { status: 400 },
    );
  }

  const routing = renewalRecipients(caseRow);
  const rate = renewalRate(caseRow);

  return NextResponse.json({
    data: {
      caseNumber: caseRow.case_number,
      endDate: caseRow.end_date,
      clientName: caseRow.client_company_name || caseRow.client_name,
      subtotal: rate,
      total: Math.round(rate * 1.18 * 100) / 100,
      escalationPercentage: caseRow.renewal_escalation_percentage ?? 0,
      billing: routing.billing,
      headsUp: routing.headsUp,
      blocked: routing.blocked,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const body = (await request.json().catch(() => ({}))) as RenewalNoticeBody;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();

  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to send renewal notices" }, { status: 403 });
  }

  const cc = (body.cc ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const invalid = cc.filter((e) => !EMAIL_RE.test(e));
  if (invalid.length) {
    return NextResponse.json({ error: `Invalid email address: ${invalid.join(", ")}` }, { status: 400 });
  }

  const { adminSupabase, caseRow } = await loadCase(caseId);
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!caseRow.end_date) {
    return NextResponse.json(
      { error: "This case has no end date, so there is no renewal to notify about." },
      { status: 400 },
    );
  }

  const routing = renewalRecipients(caseRow);
  if (routing.blocked) {
    return NextResponse.json({ error: routing.blocked }, { status: 400 });
  }
  if (!routing.billing.email) {
    return NextResponse.json(
      { error: `No email address on file for ${routing.billing.name}. Add one before sending.` },
      { status: 400 },
    );
  }

  // Same sequence the cron runs, so a manual notice is indistinguishable from
  // an automated one to the recipient — and settles through the same link.
  const periodStart = caseRow.end_date;
  const periodEndDate = new Date(caseRow.end_date);
  periodEndDate.setMonth(periodEndDate.getMonth() + (caseRow.tenure_months ?? 12));
  const periodEnd = periodEndDate.toISOString().slice(0, 10);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);
  const dueDateStr = dueDate.toISOString().slice(0, 10);

  const piNumber = `TWV-PI-${caseRow.case_number.replace(/\D/g, "")}-M${Date.now().toString().slice(-4)}`;
  const totalAmount = Math.round(renewalRate(caseRow) * 1.18 * 100) / 100;

  try {
    const statementId = await createRenewalBillingStatement({
      adminSupabase,
      caseData: caseRow,
      periodStart,
      periodEnd,
      dueDate: dueDateStr,
      piNumber,
    });

    const razorpayLink = await createRenewalRazorpayLink({
      adminSupabase,
      caseData: caseRow,
      statementId,
      totalAmount,
      dueDate: dueDateStr,
      piNumber,
    });

    const pdfBuffer = generateRenewalPI({
      caseData: caseRow,
      piNumber,
      periodStart,
      periodEnd,
      dueDate: dueDateStr,
      razorpayUrl: razorpayLink.url,
    });

    const emailSent = await sendRenewalEmail({
      caseData: caseRow,
      reminderNumber: 1,
      isGraceNotice: false,
      piNumber,
      periodStart,
      periodEnd,
      totalAmount,
      razorpayUrl: razorpayLink.url,
      pdfBuffer,
      recipient: routing.billing,
      cc,
    });

    // The client is told too when someone else is being billed — the same
    // rule the cron follows, so a partner sitting on the renewal cannot
    // silently cost them a registered address.
    let headsUpSent = false;
    if (routing.headsUp?.email) {
      headsUpSent = await sendRenewalEmail({
        caseData: caseRow,
        reminderNumber: 1,
        isGraceNotice: false,
        piNumber,
        periodStart,
        periodEnd,
        totalAmount,
        razorpayUrl: razorpayLink.url,
        recipient: routing.headsUp,
      });
    }

    logAudit(supabase, {
      entityType: "case",
      entityId: caseId,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        renewal_notice_sent: {
          old: null,
          new: {
            pi_number: piNumber,
            statement_id: statementId,
            billed_to: `${routing.billing.kind}: ${routing.billing.name} <${routing.billing.email}>`,
            heads_up_to: routing.headsUp?.email ?? null,
            cc,
            total_amount: totalAmount,
            sent_manually: true,
          },
        },
      },
    });

    return NextResponse.json({
      data: {
        statementId,
        piNumber,
        totalAmount,
        emailSent,
        headsUpSent,
        sentTo: routing.billing.email,
        headsUpTo: routing.headsUp?.email ?? null,
        cc,
      },
    });
  } catch (err) {
    console.error(`[renewal-notice] manual send failed for case ${caseId}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send the renewal notice" },
      { status: 500 },
    );
  }
}

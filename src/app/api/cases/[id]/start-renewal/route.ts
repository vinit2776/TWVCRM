import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getCachedSettings } from "@/lib/app-settings-cache";
import {
  createRenewalBillingStatement,
  createRenewalRazorpayLink,
  generateRenewalPI,
  logRenewalReminder,
  sendRenewalEmail,
  sendRenewalWhatsApp,
  type VoCaseForRenewal,
} from "@/lib/vo-renewal";
import { renewalRecipients } from "@/lib/renewal-recipients";
import { statementCoversNextTerm } from "@/lib/vo-renewal-term";
import {
  RENEWAL_DURATIONS,
  RENEWAL_ESCALATION_MODES,
  renewalOffer,
} from "@/lib/vo-renewal-offer";

/**
 * GET  /api/cases/[id]/start-renewal — what the Start renewal dialog needs:
 *      the current term and fee, who is billed, and any bill it would replace.
 * POST /api/cases/[id]/start-renewal — raise the renewal bill and payment link
 *      for the term a person chose, and send it only on the channels they ticked.
 *
 * Nothing about the case's term changes here. The new term begins only when
 * the bill is paid (completeVoRenewal), and always starts the day after the
 * current one ends.
 *
 * Replaces the old "Send renewal intimation" route. Like it, this is the
 * deliberate, person-driven path, so renewal_notices_enabled (the cron's
 * opt-in) is not checked.
 */

const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "accounts"];
/** Lapsed cases need the lapsed-case decision instead (a later step). */
const STARTABLE_STATUSES = ["active", "renewal_due", "grace_period"];

const CASE_SELECT =
  "*, location:locations!cases_location_id_fkey(name, address, city, state), " +
  "aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone)";

type CaseRow = VoCaseForRenewal & {
  status: string;
  renewal_notices_enabled?: boolean | null;
};

const bodySchema = z
  .object({
    duration_months: z
      .number()
      .int()
      .refine((n) => (RENEWAL_DURATIONS as readonly number[]).includes(n), "Choose 6, 12, 24 or 36 months"),
    escalation_mode: z.enum(RENEWAL_ESCALATION_MODES),
    custom_percentage: z.number().min(0).max(100).nullish(),
    escalation_reason: z.string().trim().max(500).nullish(),
    /** The end date the person confirmed, so a stale dialog can't bill a different term. */
    confirm_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** The total they saw, for the same reason. */
    expected_total: z.number().nonnegative(),
    send_email: z.boolean().default(false),
    send_whatsapp: z.boolean().default(false),
    cc: z.array(z.string().trim().toLowerCase().email()).max(10).default([]),
  })
  .refine(
    (b) => b.escalation_mode !== "custom" || (b.custom_percentage ?? 0) > 0,
    { message: "Enter the custom escalation percentage", path: ["custom_percentage"] },
  )
  .refine(
    (b) => b.escalation_mode !== "custom" || (b.escalation_reason ?? "").length >= 10,
    { message: "Give a reason of at least 10 characters for a custom escalation", path: ["escalation_reason"] },
  );

async function loadCase(caseId: string) {
  const adminSupabase = await createAdminClient();
  const { data } = await adminSupabase.from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle();
  return { adminSupabase, caseRow: data as unknown as CaseRow | null };
}

function isPostpaid(c: CaseRow): boolean {
  return !!c.aggregator_id && c.aggregator?.billing_method === "postpaid";
}

/** Today in IST, the business's calendar day. */
function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

type OpenBill = {
  id: string;
  statement_number: string | null;
  total_amount: number;
  payment_status: string;
  razorpay_payment_link_id: string | null;
  /** Why it can't simply be replaced, if it can't. */
  locked: string | null;
};

/**
 * Unpaid renewal bills for the term after the current one. Starting a new
 * renewal replaces these, unless money is already against them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openRenewalBills(admin: any, c: CaseRow): Promise<OpenBill[]> {
  const { data: bills } = await admin
    .from("billing_statements")
    .select("id, statement_number, total_amount, payment_status, period_start, razorpay_payment_link_id")
    .eq("case_id", c.id)
    .eq("statement_type", "vo_renewal")
    .is("voided_at", null)
    .neq("payment_status", "paid");
  const open = ((bills ?? []) as Record<string, unknown>[]).filter((b) =>
    statementCoversNextTerm(b.period_start as string | null, c.end_date),
  );
  if (open.length === 0) return [];

  const ids = open.map((b) => b.id as string);
  const [paymentsRes, reportsRes] = await Promise.all([
    admin.from("billing_payments").select("billing_statement_id").in("billing_statement_id", ids),
    admin
      .from("query_payment_reports")
      .select("claimed_statement_id")
      .in("claimed_statement_id", ids)
      .eq("status", "reported"),
  ]);
  const paid = new Set(((paymentsRes.data ?? []) as Record<string, unknown>[]).map((p) => p.billing_statement_id as string));
  const reported = new Set(((reportsRes.data ?? []) as Record<string, unknown>[]).map((r) => r.claimed_statement_id as string));

  return open.map((b) => {
    const id = b.id as string;
    const number = (b.statement_number as string | null) ?? "the open renewal bill";
    return {
      id,
      statement_number: b.statement_number as string | null,
      total_amount: Number(b.total_amount),
      payment_status: b.payment_status as string,
      razorpay_payment_link_id: b.razorpay_payment_link_id as string | null,
      locked: paid.has(id)
        ? `A payment is already recorded against ${number}. Finish settling that bill instead of starting again.`
        : reported.has(id)
          ? `Someone reported a payment against ${number}. Accounts must verify or reject it before a new renewal can be started.`
          : null,
    };
  });
}

/** Best-effort, as in the void route: a link already expired or cancelled fails harmlessly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cancelRazorpayLink(admin: any, linkId: string): Promise<void> {
  try {
    const rzp = await getCachedSettings(admin, ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
    if (rzp.razorpay_enabled !== "true" || !rzp.razorpay_key_id || !rzp.razorpay_key_secret) return;
    const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
    await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (err) {
    console.warn("[start-renewal] Could not cancel the replaced payment link (non-fatal):", err);
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { adminSupabase, caseRow } = await loadCase(caseId);
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!caseRow.end_date) {
    return NextResponse.json({ error: "This case has no end date, so there is no term to renew." }, { status: 400 });
  }

  const routing = renewalRecipients(caseRow);
  const openBills = await openRenewalBills(adminSupabase, caseRow);

  return NextResponse.json({
    data: {
      caseNumber: caseRow.case_number,
      clientName: caseRow.client_company_name || caseRow.client_name,
      purpose: caseRow.purpose,
      status: caseRow.status,
      endDate: caseRow.end_date,
      currentFee: Number(caseRow.rate),
      tenureMonths: caseRow.tenure_months ?? 12,
      agreedEscalationPercentage: caseRow.renewal_escalation_percentage ?? 0,
      billing: routing.billing,
      headsUp: routing.headsUp,
      blocked: routing.blocked,
      postpaid: isPostpaid(caseRow),
      startable: STARTABLE_STATUSES.includes(caseRow.status),
      openBills: openBills.map(({ id, statement_number, total_amount, locked }) => ({
        id, statement_number, total_amount, locked,
      })),
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: caseId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to start renewals" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const body = parsed.data;

  const { adminSupabase, caseRow } = await loadCase(caseId);
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!caseRow.end_date) {
    return NextResponse.json({ error: "This case has no end date, so there is no term to renew." }, { status: 400 });
  }
  if (!STARTABLE_STATUSES.includes(caseRow.status)) {
    return NextResponse.json({ error: `A ${caseRow.status.replace(/_/g, " ")} case can't be renewed from here.` }, { status: 400 });
  }
  if (isPostpaid(caseRow)) {
    return NextResponse.json(
      { error: "This case is billed monthly to a postpaid partner, so it has no renewal bill." },
      { status: 400 },
    );
  }
  if (!(Number(caseRow.rate) > 0)) {
    return NextResponse.json({ error: "This case has no fee on record. Set its rate first." }, { status: 400 });
  }

  const routing = renewalRecipients(caseRow);
  if (routing.blocked) return NextResponse.json({ error: routing.blocked }, { status: 400 });
  if (body.send_email && !routing.billing.email) {
    return NextResponse.json({ error: `No email address on file for ${routing.billing.name}.` }, { status: 400 });
  }
  if (body.send_whatsapp && !routing.billing.phone) {
    return NextResponse.json({ error: `No phone number on file for ${routing.billing.name}.` }, { status: 400 });
  }

  const offer = renewalOffer({
    currentFee: Number(caseRow.rate),
    currentTenureMonths: caseRow.tenure_months,
    agreedEscalationPercentage: caseRow.renewal_escalation_percentage,
    currentEnd: caseRow.end_date,
    durationMonths: body.duration_months,
    mode: body.escalation_mode,
    customPercentage: body.custom_percentage,
  });
  if (offer.term.end !== body.confirm_end_date || Math.abs(offer.total - body.expected_total) > 0.005) {
    return NextResponse.json(
      { error: "The case changed while this was open. Close the dialog and start again." },
      { status: 409 },
    );
  }

  const replaced = await openRenewalBills(adminSupabase, caseRow);
  const locked = replaced.find((b) => b.locked);
  if (locked) return NextResponse.json({ error: locked.locked }, { status: 409 });

  const today = todayIst();
  const dueDate = offer.term.start > today ? offer.term.start : today;
  const piNumber = `TWV-PI-${caseRow.case_number.replace(/\D/g, "")}-M${Date.now().toString().slice(-4)}`;

  let statementId: string;
  let link: { id: string; url: string };
  try {
    statementId = await createRenewalBillingStatement({
      adminSupabase,
      caseData: caseRow,
      periodStart: offer.term.start,
      periodEnd: offer.term.end,
      dueDate,
      piNumber,
      subtotal: offer.fee,
    });
    link = await createRenewalRazorpayLink({
      adminSupabase,
      caseData: caseRow,
      statementId,
      totalAmount: offer.total,
      dueDate,
      piNumber,
      notifyCustomer: false,
    });
  } catch (err) {
    console.error(`[start-renewal] could not raise the renewal bill for case ${caseId}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not raise the renewal bill" },
      { status: 500 },
    );
  }

  // Only now that the new bill exists, retire the one it replaces, so a
  // failure above never leaves the case with no payable bill.
  for (const old of replaced) {
    await adminSupabase
      .from("billing_statements")
      .update({
        status: "voided",
        voided_at: new Date().toISOString(),
        voided_by: dbUser.id,
        void_reason: "Replaced by a new renewal offer",
      })
      .eq("id", old.id)
      .is("voided_at", null);
    if (old.razorpay_payment_link_id) await cancelRazorpayLink(adminSupabase, old.razorpay_payment_link_id);
  }

  let emailSent = false;
  let headsUpSent = false;
  let whatsAppSent = false;
  if (body.send_email || body.send_whatsapp) {
    const pdfBuffer = generateRenewalPI({
      caseData: caseRow,
      piNumber,
      periodStart: offer.term.start,
      periodEnd: offer.term.end,
      dueDate,
      razorpayUrl: link.url,
      subtotal: offer.fee,
    });
    const notice = {
      caseData: caseRow,
      reminderNumber: 1,
      isGraceNotice: false,
      piNumber,
      periodStart: offer.term.start,
      periodEnd: offer.term.end,
      totalAmount: offer.total,
      razorpayUrl: link.url,
    };
    if (body.send_email) {
      emailSent = await sendRenewalEmail({ ...notice, pdfBuffer, recipient: routing.billing, cc: body.cc });
      // The client hears too when a partner is billed, as the cron does.
      if (routing.headsUp?.email) {
        headsUpSent = await sendRenewalEmail({ ...notice, recipient: routing.headsUp });
      }
    }
    if (body.send_whatsapp) {
      whatsAppSent = await sendRenewalWhatsApp({
        caseData: caseRow,
        isGraceNotice: false,
        piNumber,
        totalAmount: offer.total,
        razorpayUrl: link.url,
        pdfBuffer,
        supabase: adminSupabase,
        recipient: routing.billing,
      });
    }
    if (emailSent || whatsAppSent) {
      await logRenewalReminder({
        adminSupabase,
        caseId,
        reminderNumber: 1,
        statementId,
        razorpayLinkId: link.id,
        razorpayLinkUrl: link.url,
        emailSent,
        whatsAppSent,
        isGraceNotice: false,
      });
    }
  }

  const sentAny = emailSent || whatsAppSent;
  const caseUpdate: Record<string, unknown> = {
    renewal_billing_statement_id: statementId,
    renewal_razorpay_link_id: link.id,
    renewal_razorpay_link_url: link.url,
    renewal_reminder_count: sentAny ? 1 : 0,
    ...(sentAny ? { renewal_last_reminder_at: new Date().toISOString() } : {}),
  };
  if (caseRow.status === "active") {
    caseUpdate.status = "renewal_due";
    caseUpdate.renewal_due_at = new Date().toISOString();
  }
  await adminSupabase.from("cases").update(caseUpdate).eq("id", caseId);

  logAudit(supabase, {
    entityType: "case",
    entityId: caseId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "renewal_started" },
      renewal_offer: {
        old: null,
        new: {
          pi_number: piNumber,
          statement_id: statementId,
          term_start: offer.term.start,
          term_end: offer.term.end,
          duration_months: offer.durationMonths,
          current_fee: Number(caseRow.rate),
          current_tenure_months: caseRow.tenure_months ?? 12,
          base_fee: offer.baseFee,
          escalation_mode: body.escalation_mode,
          escalation_percentage: offer.escalationPercentage,
          escalation_reason: body.escalation_reason || null,
          fee: offer.fee,
          total_amount: offer.total,
          billed_to: `${routing.billing.kind}: ${routing.billing.name}`,
          email_sent: emailSent,
          heads_up_sent: headsUpSent,
          whatsapp_sent: whatsAppSent,
          cc: body.cc,
          replaced_statements: replaced.map((b) => b.statement_number ?? b.id),
        },
      },
      ...(caseUpdate.status ? { status: { old: caseRow.status, new: caseUpdate.status } } : {}),
    },
  });

  return NextResponse.json({
    data: {
      statementId,
      piNumber,
      paymentLink: link.url,
      total: offer.total,
      termStart: offer.term.start,
      termEnd: offer.term.end,
      emailSent,
      headsUpSent,
      whatsAppSent,
      sentTo: emailSent ? routing.billing.email : null,
      replaced: replaced.length,
    },
  });
}

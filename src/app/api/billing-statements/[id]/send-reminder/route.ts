import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  STAGES, pickStageIndex, daysOverdueFromDueDate,
  sendOneReminder, fetchCcPools,
} from "@/lib/payment-reminder";

/**
 * POST /api/billing-statements/[id]/send-reminder
 *
 * Manual "Send Reminder Now" — fires from the AR-page row button. Sends the
 * next stage in the ladder (or replays the current stage if explicitly forced
 * via { stage: <index> } in the body, for ops to retry a failed send).
 *
 * Bypasses the 48h cron throttle on purpose: an accounts user clicking the
 * button is making a deliberate decision. The cron's reminder_count gate
 * still advances after a manual send, so the next cron tick won't duplicate.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts / Sales Rep access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { stage?: number };

  const admin = createAdminClient();
  const { data: statement, error } = await admin
    .from("billing_statements")
    .select(`
      id, statement_number, period_start, period_end, due_date, total_amount,
      payment_status, status, razorpay_payment_link_id, razorpay_payment_link_url,
      reminder_count, last_reminder_sent_at, voided_at,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)
      )
    `)
    .eq("id", id)
    .single();

  if (error || !statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (statement.voided_at) return NextResponse.json({ error: "Cannot send reminder for a voided statement" }, { status: 400 });
  if (statement.payment_status === "paid") return NextResponse.json({ error: "Statement is already paid" }, { status: 400 });
  if (!["finalized", "exported"].includes(statement.status as string)) {
    return NextResponse.json({ error: "Statement must be finalized before sending a reminder" }, { status: 400 });
  }
  if (!statement.due_date) {
    return NextResponse.json({ error: "Statement has no due date — cannot determine ladder stage" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract: any = statement.contract;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposal: any = statement.proposal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoice: any = statement.invoice;
  const lead = contract?.lead ?? proposal?.lead ?? invoice?.lead;
  if (!lead?.email && !(lead?.mobile || lead?.phone)) {
    return NextResponse.json({ error: "Customer has no email or phone — cannot send reminder" }, { status: 400 });
  }

  // Stage selection: caller can override (replay) or we pick the next due stage.
  let stageIdx: number;
  if (typeof body.stage === "number" && body.stage >= 0 && body.stage < STAGES.length) {
    stageIdx = body.stage;
  } else {
    const days = daysOverdueFromDueDate(statement.due_date as string);
    const ladder = pickStageIndex(days);
    // If pre-due, allow the friendly "due today" reminder anyway (manual override).
    stageIdx = Math.max(0, ladder);
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  const ccPools = await fetchCcPools(admin);

  const result = await sendOneReminder(admin, {
    statement, stageIdx, appUrl,
    triggeredBy: "manual", triggeredByUserId: dbUser.id, ccPools,
  });

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      manual_reminder_sent: {
        old: null,
        new: `stage ${stageIdx} (${result.toneLabel}) via ${[result.emailSent && "email", result.whatsAppSent && "wa"].filter(Boolean).join("+") || "none"}`,
      },
    },
  });

  return NextResponse.json({
    stageIdx: result.stageIdx,
    toneLabel: result.toneLabel,
    emailSent: result.emailSent,
    whatsAppSent: result.whatsAppSent,
    recipient: result.recipient,
    errors: result.errors,
  });
}

/**
 * GET /api/billing-statements/[id]/send-reminder
 *
 * Returns the unified send activity log for this statement — every reminder
 * (cron or manual) AND every proforma/GST invoice send/resend from
 * billing_send_log, merged and sorted most-recent first. Used by the AR page
 * "History" drawer, so accounts can answer "what have we sent for this
 * invoice, to whom, and did it go through" without leaving the page.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [remindersRes, sendLogRes] = await Promise.all([
    supabase
      .from("billing_reminder_sends")
      .select("id, stage_index, stage_label, channel, recipient, status, error, triggered_by, sent_at, triggered_by_user:users!billing_reminder_sends_triggered_by_user_id_fkey(full_name)")
      .eq("billing_statement_id", id),
    supabase
      .from("billing_send_log")
      .select("id, send_type, recipient, status, error, triggered_by, triggered_by_user_id, sent_at")
      .eq("billing_statement_id", id),
  ]);

  if (remindersRes.error) return NextResponse.json({ error: remindersRes.error.message }, { status: 500 });
  if (sendLogRes.error) return NextResponse.json({ error: sendLogRes.error.message }, { status: 500 });

  const sendLogRows = sendLogRes.data || [];
  const userIds = Array.from(new Set(sendLogRows.map((r) => r.triggered_by_user_id).filter(Boolean))) as string[];
  const userNameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", userIds);
    for (const u of users || []) userNameById.set(u.id, u.full_name);
  }

  const sendLogHistory = sendLogRows.map((r) => ({
    id: r.id,
    stage_index: -1,
    stage_label: r.send_type === "proforma" ? "Proforma sent" : "GST invoice sent",
    channel: "email",
    recipient: r.recipient,
    status: r.status,
    error: r.error,
    triggered_by: r.triggered_by,
    sent_at: r.sent_at,
    triggered_by_user: r.triggered_by_user_id && userNameById.has(r.triggered_by_user_id)
      ? { full_name: userNameById.get(r.triggered_by_user_id)! }
      : null,
  }));

  const history = [...(remindersRes.data || []), ...sendLogHistory]
    .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());

  return NextResponse.json({ history });
}

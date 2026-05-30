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
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
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
  const lead = contract?.lead;
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
 * Returns the activity log for this statement — every reminder send (cron
 * or manual), most-recent first. Used by the AR page "History" drawer.
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
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("billing_reminder_sends")
    .select("id, stage_index, stage_label, channel, recipient, status, error, triggered_by, sent_at, triggered_by_user:users!billing_reminder_sends_triggered_by_user_id_fkey(full_name)")
    .eq("billing_statement_id", id)
    .order("sent_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ history: data || [] });
}

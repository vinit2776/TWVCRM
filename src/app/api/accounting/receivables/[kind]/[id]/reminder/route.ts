import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { fetchCcPools, daysOverdueFromDueDate } from "@/lib/payment-reminder";
import { pickStageForKind, sendReceivableReminder } from "@/lib/receivable-reminder";
import { fetchDunnableReceivables, type DunnableKind } from "@/lib/receivable-fetch";

const ALLOWED_ROLES = ["admin", "manager", "accounts"];
const KINDS: DunnableKind[] = ["deposit", "topup", "adhoc_invoice"];

function isKind(v: string): v is DunnableKind {
  return (KINDS as string[]).includes(v);
}

/**
 * POST — send the next ladder stage now, bypassing the 48h throttle.
 * GET  — the send history for this receivable.
 *
 * Mirrors the statement-level "Send Reminder Now" button so deposits,
 * top-ups and ad-hoc PIs aren't stuck waiting on the daily cron.
 *
 * Note this deliberately ignores followup_enabled: that flag suppresses the
 * *automated* drumbeat for the pre-existing backlog, but an operator who
 * has looked at the row and clicked send is making a considered decision.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const { kind, id } = await params;
  if (!isKind(kind)) return NextResponse.json({ error: "Unknown receivable kind" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !ALLOWED_ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "Not authorised to send reminders" }, { status: 403 });
  }

  const admin = createAdminClient();
  const rows = await fetchDunnableReceivables(admin, { kind, id });
  const row = rows[0];

  if (!row) {
    return NextResponse.json(
      { error: "Nothing to chase — this receivable is settled, cancelled, or not chaseable" },
      { status: 404 },
    );
  }
  if (!row.email && !row.phone) {
    return NextResponse.json({ error: "No email or phone on file for this customer" }, { status: 422 });
  }
  if (!row.due_date) {
    return NextResponse.json(
      { error: "No due date set — send the payment link first so the follow-up has a clock to run against" },
      { status: 422 },
    );
  }

  const days = daysOverdueFromDueDate(row.due_date);
  // Clamp to stage 0 so an operator can still send a courtesy nudge before
  // the due date, exactly as the statement button allows.
  const stageIdx = Math.max(0, pickStageForKind(row.kind, days));

  const ccPools = await fetchCcPools(admin);
  const res = await sendReceivableReminder(admin, {
    kind: row.kind, id: row.id, reference: row.reference, partyName: row.party_name,
    email: row.email, phone: row.phone, amount: row.amount, dueDate: row.due_date,
    daysOverdue: days, stageIdx, payLinkUrl: row.payment_link_url,
    triggeredBy: "manual", triggeredByUserId: actor.id, ccPools,
  });

  if (!res.emailSent && !res.whatsAppSent) {
    return NextResponse.json(
      { error: res.errors[0] || "Reminder could not be sent" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    data: {
      stage: res.stageIdx, tone: res.toneLabel,
      email_sent: res.emailSent, whatsapp_sent: res.whatsAppSent,
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const { kind, id } = await params;
  if (!isKind(kind)) return NextResponse.json({ error: "Unknown receivable kind" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("receivable_reminder_sends")
    .select(`
      id, stage_index, stage_label, channel, recipient, status, error,
      triggered_by, created_at,
      triggered_by_user:users!receivable_reminder_sends_triggered_by_user_id_fkey(full_name)
    `)
    .eq("kind", kind)
    .eq("receivable_id", id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (data || []).map((r) => ({
    ...r,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    triggered_by_name: (r.triggered_by_user as any)?.full_name ?? null,
  }));

  return NextResponse.json({ items });
}

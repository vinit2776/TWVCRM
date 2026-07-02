/**
 * GET /api/leads/[id]/billing-communications
 *
 * Unified billing-communication timeline for a lead: every proforma/GST
 * invoice send, payment reminder, and payment received across ALL contracts
 * owned by this lead. Feeds the "Communications" section on LeadTimeline —
 * answers "what have we sent this customer, and did they pay?" without
 * digging through billing/AR pages statement by statement.
 *
 * Auth: admin, manager, accounts — mirrors billing_send_log / billing_reminder_sends RLS.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface CommEvent {
  kind: "proforma_sent" | "gst_invoice_sent" | "reminder_sent" | "payment_received";
  occurred_at: string;
  statement_id: string;
  statement_number: string | null;
  contract_number: string | null;
  detail: string;
  recipient?: string;
  status?: "sent" | "failed";
  amount?: number;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: contracts } = await supabase
    .from("contracts")
    .select("id, contract_number")
    .eq("lead_id", leadId);
  const contractIds = (contracts || []).map((c) => c.id);
  const contractNumberById = new Map((contracts || []).map((c) => [c.id, c.contract_number]));

  if (contractIds.length === 0) {
    return NextResponse.json({ data: [] });
  }

  const { data: statements } = await supabase
    .from("billing_statements")
    .select("id, statement_number, contract_id")
    .in("contract_id", contractIds);
  const statementIds = (statements || []).map((s) => s.id);
  const statementMeta = new Map(
    (statements || []).map((s) => [
      s.id,
      { statement_number: s.statement_number, contract_number: contractNumberById.get(s.contract_id) ?? null },
    ]),
  );

  if (statementIds.length === 0) {
    return NextResponse.json({ data: [] });
  }

  const [sendLogRes, reminderRes, paymentsRes] = await Promise.all([
    supabase
      .from("billing_send_log")
      .select("billing_statement_id, send_type, recipient, status, sent_at")
      .in("billing_statement_id", statementIds),
    supabase
      .from("billing_reminder_sends")
      .select("billing_statement_id, stage_label, channel, recipient, status, sent_at")
      .in("billing_statement_id", statementIds),
    supabase
      .from("billing_payments")
      .select("billing_statement_id, amount, payment_date, payment_mode, created_at")
      .in("billing_statement_id", statementIds),
  ]);

  const events: CommEvent[] = [];

  for (const row of sendLogRes.data || []) {
    const meta = statementMeta.get(row.billing_statement_id);
    events.push({
      kind: row.send_type === "proforma" ? "proforma_sent" : "gst_invoice_sent",
      occurred_at: row.sent_at,
      statement_id: row.billing_statement_id,
      statement_number: meta?.statement_number ?? null,
      contract_number: meta?.contract_number ?? null,
      detail: row.send_type === "proforma" ? "Proforma invoice sent" : "GST tax invoice sent",
      recipient: row.recipient,
      status: row.status as "sent" | "failed",
    });
  }

  for (const row of reminderRes.data || []) {
    const meta = statementMeta.get(row.billing_statement_id);
    events.push({
      kind: "reminder_sent",
      occurred_at: row.sent_at,
      statement_id: row.billing_statement_id,
      statement_number: meta?.statement_number ?? null,
      contract_number: meta?.contract_number ?? null,
      detail: `${row.stage_label} (${row.channel})`,
      recipient: row.recipient,
      status: row.status as "sent" | "failed",
    });
  }

  for (const row of paymentsRes.data || []) {
    const meta = statementMeta.get(row.billing_statement_id);
    events.push({
      kind: "payment_received",
      occurred_at: row.created_at,
      statement_id: row.billing_statement_id,
      statement_number: meta?.statement_number ?? null,
      contract_number: meta?.contract_number ?? null,
      detail: `Payment received (${row.payment_mode})`,
      amount: Number(row.amount),
    });
  }

  events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

  return NextResponse.json({ data: events });
}

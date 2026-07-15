/**
 * GET /api/leads/[id]/billing-communications
 *
 * Unified billing-communication timeline for a lead: every proforma/GST
 * invoice send, payment reminder, and payment received across ALL contracts
 * owned by this lead, PLUS proposal-level deposit and pro-rata payments
 * (a separate revenue stream — see CLAUDE.md "Proposal → Contract Flow").
 * Feeds the "Communications" section on LeadTimeline — answers "what have
 * we sent this customer, and did they pay?" without digging through
 * billing/AR pages or individual proposals.
 *
 * Proposal payments have no dedicated line-item table (unlike billing_payments) —
 * they're status flags + a single timestamp/amount/reference on the proposal
 * row itself, so each one becomes at most one deposit event and one pro-rata
 * event, regardless of contract activation state. This matters for leads
 * whose contract hasn't activated yet (no billing_statements exist yet) —
 * without this, their proposal payment wouldn't show anywhere on the timeline.
 *
 * Auth: admin, manager, accounts — mirrors billing_send_log / billing_reminder_sends RLS.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAttachmentUrls } from "@/lib/communications-log";
import type { CommunicationLogEntry } from "@/types";

export const dynamic = "force-dynamic";

interface CommEvent {
  kind: "proforma_sent" | "gst_invoice_sent" | "reminder_sent" | "payment_received"
    | "proposal_deposit_paid" | "proposal_prorata_paid"
    | "statement_finalized" | "statement_voided" | "gst_invoice_uploaded"
    | "contract_payment_received";
  occurred_at: string;
  statement_id: string;
  statement_number: string | null;
  contract_number: string | null;
  detail: string;
  recipient?: string;
  status?: "sent" | "failed";
  amount?: number;
  /** Full content (subject/body/attachment) when this send went through
   *  logCommunication() — lets the timeline row expand to show exactly what
   *  was sent, matched by statement + kind + closest timestamp. Absent for
   *  sends from routes not yet migrated to communications_log. */
  commLogEntry?: CommunicationLogEntry | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(
  req: NextRequest,
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

  const { searchParams } = new URL(req.url);
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || "", 10) || DEFAULT_LIMIT));

  const events: CommEvent[] = [];

  // ── Proposal-level payments (deposit + pro-rata) ────────────────────────
  // Independent of contracts/statements existing — a proposal can be paid
  // long before its contract activates.
  const { data: proposals } = await supabase
    .from("proposals")
    .select(`
      id, proposal_number,
      payment_status, payment_received_at, payment_amount, payment_reference,
      deposit_payment_status, deposit_payment_received_at, deposit_payment_amount, deposit_payment_reference
    `)
    .eq("lead_id", leadId);

  for (const p of proposals || []) {
    if (p.deposit_payment_status === "paid" && p.deposit_payment_received_at) {
      events.push({
        kind: "proposal_deposit_paid",
        occurred_at: p.deposit_payment_received_at,
        statement_id: p.id,
        statement_number: p.proposal_number,
        contract_number: null,
        detail: "Security deposit paid",
        amount: p.deposit_payment_amount != null ? Number(p.deposit_payment_amount) : undefined,
      });
    }
    if (p.payment_status === "paid" && p.payment_received_at) {
      events.push({
        kind: "proposal_prorata_paid",
        occurred_at: p.payment_received_at,
        statement_id: p.id,
        statement_number: p.proposal_number,
        contract_number: null,
        detail: "Pro-rata invoice paid",
        amount: p.payment_amount != null ? Number(p.payment_amount) : undefined,
      });
    }
  }

  const { data: contracts } = await supabase
    .from("contracts")
    .select("id, contract_number")
    .eq("lead_id", leadId);
  const contractIds = (contracts || []).map((c) => c.id);
  const contractNumberById = new Map((contracts || []).map((c) => [c.id, c.contract_number]));

  // Contract payments (Finance > Acc Payables) aren't gated behind a billing
  // statement existing — a payment can be recorded against a contract before
  // its first statement is ever generated — so this runs independently of
  // the statementIds early-return below.
  if (contractIds.length > 0) {
    const { data: contractPayments } = await supabase
      .from("contract_payments")
      .select("contract_id, amount, payment_mode, status, created_at")
      .in("contract_id", contractIds)
      .neq("status", "rejected");

    for (const row of contractPayments || []) {
      events.push({
        kind: "contract_payment_received",
        occurred_at: row.created_at,
        statement_id: row.contract_id,
        statement_number: null,
        contract_number: contractNumberById.get(row.contract_id) ?? null,
        detail: `Payment received (${row.payment_mode})`,
        amount: Number(row.amount),
      });
    }
  }

  const finish = () => {
    events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
    const page = events.slice(offset, offset + limit);
    return NextResponse.json({
      data: page,
      total: events.length,
      has_more: offset + limit < events.length,
    });
  };

  if (contractIds.length === 0) {
    return finish();
  }

  const { data: statements } = await supabase
    .from("billing_statements")
    .select("id, statement_number, contract_id, status, finalized_at, voided_at, void_reason")
    .in("contract_id", contractIds);
  const statementIds = (statements || []).map((s) => s.id);
  const statementMeta = new Map(
    (statements || []).map((s) => [
      s.id,
      { statement_number: s.statement_number, contract_number: contractNumberById.get(s.contract_id) ?? null },
    ]),
  );

  // Finalized/voided are independent checks, not mutually exclusive on current
  // `status` — voiding a statement does not clear `finalized_at`, so a
  // finalized-then-voided statement shows both events in its real history.
  for (const s of statements || []) {
    const meta = statementMeta.get(s.id);
    if (s.finalized_at) {
      events.push({
        kind: "statement_finalized",
        occurred_at: s.finalized_at,
        statement_id: s.id,
        statement_number: meta?.statement_number ?? null,
        contract_number: meta?.contract_number ?? null,
        detail: "Billing statement finalized",
      });
    }
    if (s.voided_at) {
      events.push({
        kind: "statement_voided",
        occurred_at: s.voided_at,
        statement_id: s.id,
        statement_number: meta?.statement_number ?? null,
        contract_number: meta?.contract_number ?? null,
        detail: s.void_reason ? `Statement voided: ${s.void_reason}` : "Statement voided",
      });
    }
  }

  if (statementIds.length === 0) {
    return finish();
  }

  const [sendLogRes, reminderRes, paymentsRes, commsLogRes, gstUploadsRes] = await Promise.all([
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
    supabase
      .from("communications_log")
      .select("*")
      .eq("entity_type", "billing_statement")
      .in("entity_id", statementIds),
    supabase
      .from("gst_invoice_uploads")
      .select("billing_statement_id, tally_invoice_number, tally_invoice_series, invoice_amount, uploaded_at")
      .in("billing_statement_id", statementIds),
  ]);

  // communications_log rows carry full content (subject/body/attachment) for
  // sends that went through logCommunication() — billing_send_log does not.
  // Match each billing_send_log row to the comm-log row from the same send
  // (same statement, compatible kind, within a few seconds of each other —
  // both writes happen back-to-back in the same request) so the timeline can
  // show an expandable row instead of just a one-line summary where available.
  const commsLogEntries = await resolveAttachmentUrls((commsLogRes.data || []) as CommunicationLogEntry[]);
  const findMatchingCommLog = (statementId: string, sendType: string, sentAt: string): CommunicationLogEntry | null => {
    const sentMs = new Date(sentAt).getTime();
    const isProforma = sendType === "proforma";
    let best: CommunicationLogEntry | null = null;
    let bestDiff = Infinity;
    for (const entry of commsLogEntries) {
      if (entry.entity_id !== statementId) continue;
      const subjectIsProforma = (entry.subject || "").startsWith("Proforma Invoice");
      if (subjectIsProforma !== isProforma) continue;
      const diff = Math.abs(new Date(entry.created_at).getTime() - sentMs);
      if (diff < bestDiff && diff <= 120_000) {
        best = entry;
        bestDiff = diff;
      }
    }
    return best;
  };

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
      commLogEntry: findMatchingCommLog(row.billing_statement_id, row.send_type, row.sent_at),
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

  for (const row of gstUploadsRes.data || []) {
    const meta = statementMeta.get(row.billing_statement_id);
    events.push({
      kind: "gst_invoice_uploaded",
      occurred_at: row.uploaded_at,
      statement_id: row.billing_statement_id,
      statement_number: meta?.statement_number ?? null,
      contract_number: meta?.contract_number ?? null,
      detail: `Tally GST invoice uploaded: ${row.tally_invoice_number} (${row.tally_invoice_series})`,
      amount: Number(row.invoice_amount),
    });
  }

  return finish();
}

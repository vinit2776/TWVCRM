import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef, type EntityRow } from "@/lib/queries/registry";
import { fanOutQueryEvent, threadParticipantIds, entityLabel, loadEntity } from "@/lib/queries/server";
import { logAudit } from "@/lib/audit";
import {
  canReviewPaymentReport,
  isPaymentReportOutcome,
  statusForOutcome,
  type PaymentReportOutcome,
} from "@/lib/queries/payment-reports";

/**
 * PATCH /api/queries/payment-reports/[id] — accounts answer a reported payment.
 *
 * Three outcomes, and the middle one is the important one:
 *
 *   verified   — the credit is in the bank and has been recorded. Requires the
 *                billing_payment_id of the real payment, which the caller
 *                creates first through POST /api/billing-statements/[id]/payment.
 *                This route never writes a payment itself: there is one way
 *                money enters the ledger and it already exists, with its own
 *                TDS handling, Tally receipt hook and settlement chain.
 *   not_found  — can't see it yet. NOT a rejection: the report stays
 *                'reported' and the thread stays open so the escalation cron
 *                keeps chasing. Ops get told where it stands.
 *   rejected   — settled as no such payment. Needs a reason; closes the thread.
 */
export const dynamic = "force-dynamic";

interface ReportRow {
  id: string;
  query_id: string;
  status: "reported" | "verified" | "rejected";
  amount: number;
  paid_on: string;
  payment_mode: string;
  target_kind: "invoice" | "deposit";
  created_by: string;
  query: {
    id: string;
    entity_type: string;
    entity_id: string;
    status: "open" | "resolved";
    audience: "all" | "roles" | "users";
    audience_roles: string[];
    audience_user_ids: string[];
  } | null;
}

const OUTCOME_HEADLINES: Record<PaymentReportOutcome, string> = {
  verified: "Reported payment verified",
  not_found: "Reported payment not found yet",
  rejected: "Reported payment rejected",
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (!canReviewPaymentReport(dbUser.role)) {
    return NextResponse.json(
      { error: "Only accounts or an admin can verify a reported payment" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    outcome?: unknown;
    billing_payment_id?: unknown;
    note?: unknown;
  };

  if (!isPaymentReportOutcome(body.outcome)) {
    return NextResponse.json({ error: "Unknown outcome" }, { status: 400 });
  }
  const outcome = body.outcome;
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (outcome === "rejected" && !note) {
    return NextResponse.json(
      { error: "Say why you're rejecting this — the reporter has to be able to go back to the customer" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  const { data: reportData, error: fetchErr } = await admin
    .from("query_payment_reports")
    .select(`
      id, query_id, status, amount, paid_on, payment_mode, target_kind, created_by,
      query:queries!query_payment_reports_query_id_fkey(
        id, entity_type, entity_id, status, audience, audience_roles, audience_user_ids
      )
    `)
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!reportData) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const report = reportData as unknown as ReportRow;
  if (report.status !== "reported") {
    return NextResponse.json(
      { error: `This report has already been settled as "${report.status}"` },
      { status: 409 },
    );
  }
  if (!report.query) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const def = queryEntityDef(report.query.entity_type);
  if (!def) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  // ── Verified: the money must actually have been recorded ─────────────────
  //
  // Two shapes of proof, because deposits have no payment row of their own.
  // For a deposit the equivalent evidence is the proposal's
  // deposit_payment_status having flipped to 'paid' — re-read here rather
  // than trusted from the client, so a report cannot be marked verified by
  // anyone who merely says the deposit was recorded.
  let paymentId: string | null = null;

  if (outcome === "verified" && report.target_kind === "deposit") {
    const { data: proposal } = await admin
      .from("proposals")
      .select("id, deposit_payment_status, deposit_payment_amount")
      .eq("id", report.query.entity_id)
      .maybeSingle();

    if (!proposal) {
      return NextResponse.json({ error: "That proposal no longer exists" }, { status: 400 });
    }
    if (proposal.deposit_payment_status !== "paid") {
      return NextResponse.json(
        {
          error:
            "Record the deposit first — this proposal's deposit still reads as unpaid, so there is nothing to verify against.",
        },
        { status: 400 },
      );
    }
  }

  if (outcome === "verified" && report.target_kind === "invoice") {
    paymentId = typeof body.billing_payment_id === "string" ? body.billing_payment_id.trim() : "";
    if (!paymentId) {
      return NextResponse.json(
        { error: "Record the payment first — a verified report must point at one" },
        { status: 400 },
      );
    }

    const { data: payment } = await admin
      .from("billing_payments")
      .select("id, amount, billing_statement_id")
      .eq("id", paymentId)
      .maybeSingle();
    if (!payment) {
      return NextResponse.json({ error: "That payment doesn't exist" }, { status: 400 });
    }

    // Guard against verifying against someone else's invoice. A report on a
    // statement must point at that statement; a report on a contract must
    // point at a statement belonging to it. Getting this wrong would mark a
    // customer's claim settled against another customer's money.
    if (report.query.entity_type === "billing_statement") {
      if (payment.billing_statement_id !== report.query.entity_id) {
        return NextResponse.json(
          { error: "That payment is against a different statement" },
          { status: 400 },
        );
      }
    } else {
      const { data: stmt } = await admin
        .from("billing_statements")
        .select("id, contract_id")
        .eq("id", payment.billing_statement_id)
        .maybeSingle();
      if (!stmt || stmt.contract_id !== report.query.entity_id) {
        return NextResponse.json(
          { error: "That payment is against a statement on a different contract" },
          { status: 400 },
        );
      }
    }
  }

  const newStatus = statusForOutcome(outcome);
  const settling = outcome !== "not_found";

  if (settling) {
    const { error: updErr } = await admin
      .from("query_payment_reports")
      .update({
        status: newStatus,
        billing_payment_id: paymentId,
        resolution_note: note || null,
        reviewed_by: dbUser.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)
      // Only settle a report still open — two people pressing Verify on the
      // same claim must not produce two settlements.
      .eq("status", "reported");
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // ── Timeline ────────────────────────────────────────────────────────────
  // 'not_found' posts an ordinary message so the thread stays a conversation
  // and the escalation clock resets off it, exactly like a typed reply.
  const eventType =
    outcome === "verified" ? "payment_verified" : outcome === "rejected" ? "payment_rejected" : "message";

  const defaultNote =
    outcome === "verified"
      ? report.target_kind === "deposit"
        ? "Found in the bank and recorded against the deposit."
        : "Found in the bank and recorded against the invoice."
      : "Not in the bank yet — will keep looking.";

  const { error: msgErr } = await admin.from("query_messages").insert({
    query_id: report.query_id,
    event_type: eventType,
    body: note || defaultNote,
    created_by: dbUser.id,
  });
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });

  if (settling) {
    const { error: closeErr } = await admin
      .from("queries")
      .update({
        status: "resolved",
        resolved_by: dbUser.id,
        resolved_at: new Date().toISOString(),
        // A settled thread has nothing left to chase.
        escalated_at: null,
      })
      .eq("id", report.query_id);
    if (closeErr) return NextResponse.json({ error: closeErr.message }, { status: 500 });
  } else {
    // A reply clears the escalation stamp so the next stretch of silence can
    // escalate again — same rule as an ordinary message.
    await admin.from("queries").update({ escalated_at: null }).eq("id", report.query_id);
  }

  const loaded = await loadEntity(admin, report.query.entity_type, report.query.entity_id);

  await fanOutQueryEvent(admin, {
    queryId: report.query_id,
    def,
    // Addressed back at the reporter and everyone already in the thread,
    // rather than at accounts who just acted.
    targeting: {
      audience: "users",
      audience_roles: [],
      audience_user_ids: [report.created_by],
    },
    entitySummary: loaded?.summary ?? null,
    entityId: report.query.entity_id,
    author: dbUser as { id: string; role: string; full_name: string },
    participantIds: await threadParticipantIds(admin, report.query_id),
    headline: OUTCOME_HEADLINES[outcome],
    message: note || defaultNote,
    notificationType: `payment_report_${outcome}`,
  });

  if (settling) {
    void logAudit(admin, {
      entityType: def.auditEntityType,
      entityId:
        (loaded?.row ? def.auditEntityId(loaded.row as EntityRow) : null) ?? report.query.entity_id,
      action: outcome === "verified" ? "payment_report_verified" : "payment_report_rejected",
      performedBy: dbUser.id,
      changes: {
        payment_report_id: { old: null, new: report.id },
        status: { old: "reported", new: newStatus },
        billing_payment_id: { old: null, new: paymentId },
        note: { old: null, new: note || defaultNote },
        context: { old: null, new: entityLabel(def, loaded?.summary ?? null) },
      },
    });
  }

  return NextResponse.json({ status: newStatus, settled: settling });
}

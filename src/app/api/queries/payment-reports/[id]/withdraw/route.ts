import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef } from "@/lib/queries/registry";
import { fanOutQueryEvent, threadParticipantIds, entityLabel, loadEntity } from "@/lib/queries/server";
import { logAudit } from "@/lib/audit";
import {
  PAYMENT_REPORT_AUDIENCE_ROLES,
  canWithdrawPaymentReport,
  type PaymentReportStatus,
  type PaymentReportTargetKind,
} from "@/lib/queries/payment-reports";

/**
 * POST /api/queries/payment-reports/[id]/withdraw — take back a report that
 * accounts has not yet verified.
 *
 * Open to the person who raised it (to fix a wrong amount or date) and to
 * accounts/admin. Only an unverified report can be withdrawn: the update is
 * conditional on status = 'reported', so a verification that lands first wins
 * and this returns 409. Nothing here touches money — an unverified report was
 * only ever a claim.
 */
export const dynamic = "force-dynamic";

interface ReportRow {
  id: string;
  query_id: string;
  status: PaymentReportStatus;
  target_kind: PaymentReportTargetKind;
  amount: number;
  created_by: string;
  query: { id: string; entity_type: string; entity_id: string } | null;
}

export async function POST(
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

  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim() : "";

  const admin = createAdminClient();
  const { data: reportData, error: fetchErr } = await admin
    .from("query_payment_reports")
    .select(`
      id, query_id, status, target_kind, amount, created_by,
      query:queries!query_payment_reports_query_id_fkey(id, entity_type, entity_id)
    `)
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!reportData) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const report = reportData as unknown as ReportRow;
  if (!report.query) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  if (report.status !== "reported") {
    return NextResponse.json(
      { error: `This report has already been settled as "${report.status}" and can't be withdrawn` },
      { status: 409 },
    );
  }
  if (report.target_kind === "booking") {
    return NextResponse.json(
      { error: "A booking payment report is settled from the booking, not withdrawn" },
      { status: 400 },
    );
  }
  if (!canWithdrawPaymentReport({
    status: report.status,
    targetKind: report.target_kind,
    role: dbUser.role,
    userId: dbUser.id,
    reportedBy: report.created_by,
  })) {
    return NextResponse.json(
      { error: "Only the person who reported this, or accounts, can withdraw it" },
      { status: 403 },
    );
  }

  const def = queryEntityDef(report.query.entity_type);
  if (!def) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  // Conditional on still being open: if accounts verified it a moment ago, this
  // matches no row and the withdrawal is refused rather than undoing their work.
  const { data: updated, error: updErr } = await admin
    .from("query_payment_reports")
    .update({
      status: "withdrawn",
      resolution_note: note || null,
      reviewed_by: dbUser.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "reported")
    .select("id");
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: "Accounts has just settled this report, so it can no longer be withdrawn" },
      { status: 409 },
    );
  }

  const message = `Withdrawn by ${dbUser.full_name}${note ? `: ${note}` : " — being corrected."}`;

  const { error: msgErr } = await admin.from("query_messages").insert({
    query_id: report.query_id,
    event_type: "resolved",
    body: message,
    created_by: dbUser.id,
  });
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });

  const { error: closeErr } = await admin
    .from("queries")
    .update({
      status: "resolved",
      resolved_by: dbUser.id,
      resolved_at: new Date().toISOString(),
      // Nothing left to chase.
      escalated_at: null,
    })
    .eq("id", report.query_id);
  if (closeErr) return NextResponse.json({ error: closeErr.message }, { status: 500 });

  const loaded = await loadEntity(admin, report.query.entity_type, report.query.entity_id);

  await fanOutQueryEvent(admin, {
    queryId: report.query_id,
    def,
    // Tell accounts the claim they were about to check is gone.
    targeting: {
      audience: "roles",
      audience_roles: [...PAYMENT_REPORT_AUDIENCE_ROLES],
      audience_user_ids: [],
    },
    entitySummary: loaded?.summary ?? null,
    entityId: report.query.entity_id,
    author: dbUser as { id: string; role: string; full_name: string },
    participantIds: await threadParticipantIds(admin, report.query_id),
    headline: "Reported payment withdrawn",
    message,
    notificationType: "payment_report_withdrawn",
  });

  void logAudit(admin, {
    entityType: def.auditEntityType,
    entityId:
      (loaded?.row ? def.auditEntityId(loaded.row as Parameters<typeof def.auditEntityId>[0]) : null) ?? report.query.entity_id,
    action: "payment_report_withdrawn",
    performedBy: dbUser.id,
    changes: {
      payment_report_id: { old: null, new: report.id },
      status: { old: "reported", new: "withdrawn" },
      note: { old: null, new: note || null },
      context: { old: null, new: entityLabel(def, loaded?.summary ?? null) },
    },
  });

  return NextResponse.json({ status: "withdrawn" });
}

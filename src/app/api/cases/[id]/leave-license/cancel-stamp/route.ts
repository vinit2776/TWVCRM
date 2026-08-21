import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/cases/[id]/leave-license/cancel-stamp
 *
 * Admin-only undo for the "stamp with company seal" action: clears the
 * signed_document link and restores the agreement's pre-stamp status
 * (re-enabling Edit Agreement when that status is draft/internally_approved,
 * same as any other agreement in that status). Only allowed when
 * stamp_reference is set — i.e. this execution was produced by the stamp
 * feature, not a genuine Leegality completion or a manually uploaded signed
 * copy, neither of which this route may touch.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admin can cancel the sign & seal stamp" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const agreementId = body?.agreement_id as string | undefined;
  if (!agreementId) {
    return NextResponse.json({ error: "agreement_id is required" }, { status: 400 });
  }

  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, status, signed_document_id, stamp_reference, pre_stamp_status")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  if (!agreement.stamp_reference) {
    return NextResponse.json(
      { error: "This agreement's signed document wasn't produced by the stamp feature — nothing to cancel." },
      { status: 400 }
    );
  }

  const restoredStatus = agreement.pre_stamp_status || "draft";

  const { data: updated, error: updateErr } = await supabase
    .from("case_agreements")
    .update({
      signed_document_id: null,
      status: restoredStatus,
      signed_at: null,
      stamp_reference: null,
      pre_stamp_status: null,
    })
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  await supabase
    .from("cases")
    .update({ ll_agreement_status: restoredStatus })
    .eq("id", caseId);

  logAudit(supabase, {
    entityType: "case_agreement",
    entityId: agreementId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "sign_seal_cancelled" },
      status: { old: agreement.status, new: restoredStatus },
      signed_document_id: { old: agreement.signed_document_id, new: null },
      stamp_reference: { old: agreement.stamp_reference, new: null },
    },
  });

  return NextResponse.json({ data: updated });
}

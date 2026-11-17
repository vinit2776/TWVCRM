import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { STAMPED_EXISTING_PREFIX } from "@/lib/company-stamp";

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
 *
 * When the stamp was put on top of an uploaded signed copy
 * (stamp-existing-document), only the stamp is undone: the uploaded copy
 * becomes the signed document again and the agreement stays executed.
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

  if (agreement.signed_document_id) {
    const { data: stampedDoc } = await (await createAdminClient())
      .from("documents")
      .select("file_path, parent_document_id")
      .eq("id", agreement.signed_document_id)
      .maybeSingle();
    const uploadedCopyId = stampedDoc?.file_path?.includes(`/${STAMPED_EXISTING_PREFIX}`)
      ? stampedDoc.parent_document_id
      : null;
    if (uploadedCopyId) {
      const { data: restored, error: restoreErr } = await supabase
        .from("case_agreements")
        .update({ signed_document_id: uploadedCopyId, stamp_reference: null })
        .eq("id", agreementId)
        .eq("case_id", caseId)
        .select("*")
        .single();
      if (restoreErr) {
        return NextResponse.json({ error: restoreErr.message }, { status: 500 });
      }
      logAudit(supabase, {
        entityType: "case_agreement",
        entityId: agreementId,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          action: { old: null, new: "sign_seal_cancelled" },
          signed_document_id: { old: agreement.signed_document_id, new: uploadedCopyId },
          stamp_reference: { old: agreement.stamp_reference, new: null },
        },
      });
      return NextResponse.json({ data: restored });
    }
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

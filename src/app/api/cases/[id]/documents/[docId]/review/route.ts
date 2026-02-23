import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reviewCaseDocumentSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

/**
 * POST: Approve or reject a case document.
 * Auto-notifies aggregator on rejection.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const { id: caseId, docId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = reviewCaseDocumentSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // Verify the document belongs to this case
  const { data: docSlot, error: slotError } = await supabase
    .from("case_documents")
    .select("id, status, label, case_id")
    .eq("id", docId)
    .eq("case_id", caseId)
    .single();

  if (slotError || !docSlot) {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }

  if (docSlot.status === "pending") {
    return NextResponse.json(
      { error: "Cannot review a document that has not been uploaded yet" },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  // Update the document status
  const { data: updatedDoc, error: updateError } = await supabase
    .from("case_documents")
    .update({
      status: result.data.status,
      rejection_reason:
        result.data.status === "rejected" ? result.data.rejection_reason : null,
      notes: result.data.notes,
      reviewed_by: dbUser?.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", docId)
    .select("*")
    .single();

  if (updateError) {
    return NextResponse.json(
      { error: updateError.message },
      { status: 500 }
    );
  }

  // Audit log
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "case_document",
      entityId: docId,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        status: { old: docSlot.status, new: result.data.status },
        ...(result.data.rejection_reason
          ? {
              rejection_reason: {
                old: null,
                new: result.data.rejection_reason,
              },
            }
          : {}),
      },
    });
  }

  return NextResponse.json({ data: updatedDoc });
}

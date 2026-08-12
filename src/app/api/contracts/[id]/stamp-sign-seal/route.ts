import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const bodySchema = z.object({
  pdfBase64: z.string().min(1),
  stampRef: z.string().min(1),
});

/**
 * POST /api/contracts/[id]/stamp-sign-seal
 *
 * Admin-only manual/offline alternative to Leegality: stores a membership
 * agreement PDF that the client generated with TWV's signature + seal image
 * already embedded (generateMembershipAgreementPDF, applyCompanyStamp: true)
 * as the contract's signed document — the same slot the manual upload card
 * fills. The stamp is placed at generation time, using the same coordinates
 * as the rest of the signature block, so placement can't drift from the
 * real layout. Does not touch Leegality or contract.status.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
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
      { error: "Only admin can stamp the sign & seal" },
      { status: 403 }
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "pdfBase64 and stampRef are required" }, { status: 400 });
  }
  const { pdfBase64, stampRef } = parsed.data;

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, signed_document_id")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (contract.signed_document_id) {
    return NextResponse.json(
      { error: "This contract already has a signed document. Remove it first to re-stamp." },
      { status: 400 }
    );
  }

  const stampedBuffer = Buffer.from(pdfBase64, "base64");

  const adminSupabase = await createAdminClient();
  const storagePath = `signed-contracts/${contractId}/stamped-sign-seal-${Date.now()}.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, stampedBuffer, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: "Storage upload failed: " + uploadError.message },
      { status: 500 }
    );
  }

  const { data: docRecord, error: docError } = await adminSupabase
    .from("documents")
    .insert({
      title: `Signed Contract - ${contract.contract_number} (Stamped, ${stampRef})`,
      file_name: `${contract.contract_number}-stamped.pdf`,
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: stampedBuffer.length,
      category: "signed_contract",
      tags: [],
      version: 1,
      uploaded_by: dbUser.id,
    })
    .select("id")
    .single();

  if (docError || !docRecord) {
    return NextResponse.json(
      { error: docError?.message || "Failed to create document record" },
      { status: 500 }
    );
  }

  const { data: updated, error: updateErr } = await supabase
    .from("contracts")
    .update({ signed_document_id: docRecord.id })
    .eq("id", contractId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: contractId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "sign_seal_stamp" },
      signed_document_id: { old: null, new: docRecord.id },
      stamp_reference: { old: null, new: stampRef },
    },
  });

  return NextResponse.json({ data: { ...updated, stamp_reference: stampRef } });
}

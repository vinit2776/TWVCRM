import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const bodySchema = z.object({
  pdfBase64: z.string().min(1),
  stampRef: z.string().min(1),
});

/**
 * POST /api/contracts/[id]/stamp-existing-document
 *
 * Admin-only: applies TWV's company stamp on top of a signed document that
 * was already uploaded manually (e.g. a customer-signed scan) — for
 * contracts where Leegality e-signing isn't being used and the customer's
 * own signature must be preserved, unlike stamp-sign-seal which regenerates
 * a fresh agreement from scratch. The client overlays the stamp image onto
 * the existing PDF (pdf-lib) and posts the result here to store; the
 * original document is kept (via parent_document_id) rather than replaced.
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
    .select("id, contract_number, signed_document_id, stamp_reference")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!contract.signed_document_id) {
    return NextResponse.json(
      { error: "This contract has no uploaded signed document to stamp." },
      { status: 400 }
    );
  }

  if (contract.stamp_reference) {
    return NextResponse.json(
      { error: "This document already carries a company stamp. Cancel it first to re-stamp." },
      { status: 400 }
    );
  }

  const adminSupabase = await createAdminClient();

  const { data: originalDoc, error: originalDocError } = await adminSupabase
    .from("documents")
    .select("id, version")
    .eq("id", contract.signed_document_id)
    .single();

  if (originalDocError || !originalDoc) {
    return NextResponse.json(
      { error: "Could not find the currently attached signed document." },
      { status: 500 }
    );
  }

  const stampedBuffer = Buffer.from(pdfBase64, "base64");

  const storagePath = `signed-contracts/${contractId}/stamped-existing-${Date.now()}.pdf`;

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
      version: (originalDoc.version || 1) + 1,
      parent_document_id: originalDoc.id,
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
    .update({ signed_document_id: docRecord.id, stamp_reference: stampRef })
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
      action: { old: null, new: "sign_seal_stamp_existing_document" },
      signed_document_id: { old: originalDoc.id, new: docRecord.id },
      stamp_reference: { old: null, new: stampRef },
    },
  });

  return NextResponse.json({ data: { ...updated, stamp_reference: stampRef } });
}

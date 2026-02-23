import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadDocumentForSigning, getSigningStatus } from "@/lib/digio";
import { logAudit } from "@/lib/audit";

/**
 * POST: Initiate e-signing via Digio OR handle Digio webhook callback.
 *
 * Body variants:
 * 1. { action: "initiate" } — Send agreement to Digio for signing
 * 2. { action: "webhook", digio_document_id, status } — Digio callback
 * 3. { action: "check_status" } — Poll current signing status
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();

  const body = await request.json();
  const action = body.action as string;

  if (action === "webhook") {
    // Digio webhook — no auth needed
    return handleWebhook(supabase, caseId, body);
  }

  // All other actions require auth
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (action === "initiate") {
    return handleInitiate(supabase, caseId, dbUser?.id);
  }

  if (action === "check_status") {
    return handleCheckStatus(supabase, caseId);
  }

  return NextResponse.json(
    { error: "Invalid action. Valid: initiate, webhook, check_status" },
    { status: 400 }
  );
}

async function handleInitiate(
  supabase: Awaited<ReturnType<typeof createClient>>,
  caseId: string,
  userId?: string
) {
  // Get the agreement
  const { data: agreement, error } = await supabase
    .from("case_agreements")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !agreement) {
    return NextResponse.json(
      { error: "Agreement not found" },
      { status: 404 }
    );
  }

  // Get the case for signer details
  const { data: caseData } = await supabase
    .from("cases")
    .select("client_name, client_email, client_phone")
    .eq("id", caseId)
    .single();

  if (!caseData?.client_email) {
    return NextResponse.json(
      { error: "Client email is required for e-signing" },
      { status: 400 }
    );
  }

  // Get the generated PDF
  let pdfBuffer = Buffer.alloc(0);
  if (agreement.generated_document_id) {
    const { data: doc } = await supabase
      .from("documents")
      .select("file_path")
      .eq("id", agreement.generated_document_id)
      .single();

    if (doc?.file_path) {
      const { data: fileData } = await supabase.storage
        .from("documents")
        .download(doc.file_path);

      if (fileData) {
        pdfBuffer = Buffer.from(await fileData.arrayBuffer());
      }
    }
  }

  // Upload to Digio
  const digioResult = await uploadDocumentForSigning({
    pdfBuffer,
    documentName: `Agreement-${agreement.agreement_number || caseId}`,
    signerName: caseData.client_name,
    signerEmail: caseData.client_email,
    signerPhone: caseData.client_phone || "",
    signMethod: "aadhaar_otp",
    expiryDays: 15,
  });

  // Update agreement with Digio details
  await supabase
    .from("case_agreements")
    .update({
      status: "signing",
      digio_document_id: digioResult.documentId,
      digio_sign_url: digioResult.signUrl,
      digio_status: digioResult.status,
    })
    .eq("id", agreement.id);

  // Update case status
  await supabase
    .from("cases")
    .update({
      agreement_status: "signing",
    })
    .eq("id", caseId);

  // Audit
  if (userId) {
    logAudit(supabase, {
      entityType: "case_agreement",
      entityId: agreement.id,
      action: "update",
      performedBy: userId,
      changes: {
        action: { old: null, new: "initiated_signing" },
        digio_document_id: { old: null, new: digioResult.documentId },
      },
    });
  }

  return NextResponse.json({
    data: {
      digio_document_id: digioResult.documentId,
      sign_url: digioResult.signUrl,
      status: digioResult.status,
      expires_at: digioResult.expiresAt,
    },
  });
}

async function handleWebhook(
  supabase: Awaited<ReturnType<typeof createClient>>,
  caseId: string,
  body: Record<string, unknown>
) {
  const digioDocumentId = body.digio_document_id as string;
  const digioStatus = body.status as string;

  if (!digioDocumentId) {
    return NextResponse.json(
      { error: "digio_document_id required" },
      { status: 400 }
    );
  }

  // Find the agreement
  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id")
    .eq("case_id", caseId)
    .eq("digio_document_id", digioDocumentId)
    .single();

  if (!agreement) {
    return NextResponse.json(
      { error: "Agreement not found for this Digio document" },
      { status: 404 }
    );
  }

  const updateData: Record<string, unknown> = {
    digio_status: digioStatus,
  };

  if (digioStatus === "SIGNED") {
    updateData.status = "executed";
    updateData.signed_at = new Date().toISOString();

    // Also update case
    await supabase
      .from("cases")
      .update({
        agreement_status: "executed",
        status: "executed",
        executed_at: new Date().toISOString(),
      })
      .eq("id", caseId);
  }

  await supabase
    .from("case_agreements")
    .update(updateData)
    .eq("id", agreement.id);

  return NextResponse.json({ message: "Webhook processed" });
}

async function handleCheckStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  caseId: string
) {
  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("digio_document_id, digio_status, status")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!agreement?.digio_document_id) {
    return NextResponse.json(
      { error: "No Digio signing in progress" },
      { status: 404 }
    );
  }

  const status = await getSigningStatus(agreement.digio_document_id);

  // Update stored status
  await supabase
    .from("case_agreements")
    .update({ digio_status: status.status })
    .eq("case_id", caseId)
    .eq("digio_document_id", agreement.digio_document_id);

  return NextResponse.json({ data: status });
}

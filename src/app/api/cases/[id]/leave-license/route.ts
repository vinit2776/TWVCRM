import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  mergeLeaveLicenseVariables,
  generateLeaveLicensePdf,
} from "@/lib/leave-license-generator";
import { checkVoExecutionPaymentGate } from "@/lib/vo-execution-gate";

/**
 * GET: Get Leave & License agreement details with signed PDF URL
 * POST: Generate a new L&L agreement for a case
 * PUT: Update L&L agreement variables and regenerate PDF
 * PATCH: Update L&L agreement status
 */

export async function GET(
  _request: NextRequest,
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

  const adminSupabase = await createAdminClient();

  const { data: agreement, error } = await adminSupabase
    .from("case_agreements")
    .select("*, generated_document:documents!case_agreements_generated_document_id_fkey(file_path, file_name)")
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !agreement) {
    return NextResponse.json({ error: "No leave & license agreement found" }, { status: 404 });
  }

  // Generate signed URL for viewing the PDF
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docRaw = agreement.generated_document as any;
  const doc = Array.isArray(docRaw) ? docRaw[0] : docRaw;
  let pdfUrl: string | null = null;

  if (doc?.file_path) {
    const { data: signedUrlData } = await adminSupabase.storage
      .from("crm-documents")
      .createSignedUrl(doc.file_path, 3600);
    pdfUrl = signedUrlData?.signedUrl || null;
  }

  return NextResponse.json({
    data: agreement,
    pdf_url: pdfUrl,
  });
}

export async function POST(
  _request: NextRequest,
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

  // Fetch the case with location data
  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select(
      "*, location:locations!cases_location_id_fkey(id, name, code, address, city, state)"
    )
    .eq("id", caseId)
    .single();

  if (caseError || !caseData) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  if (!caseData.rate) {
    return NextResponse.json(
      { error: "Case rate must be set before generating an agreement" },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const location = caseData.location as { name: string; address?: string; city?: string; state?: string } | null;

  const locationAddress = [
    location?.address,
    location?.city,
    location?.state,
  ]
    .filter(Boolean)
    .join(", ") || "Chennai";

  const clientAddress = [
    caseData.client_address,
    caseData.client_city,
    caseData.client_state,
    caseData.client_pincode,
  ]
    .filter(Boolean)
    .join(", ");

  const variables = mergeLeaveLicenseVariables({
    agreementNumber: "",
    agreementDate: new Date().toISOString(),
    clientName: caseData.client_name,
    clientCompanyName: caseData.client_company_name,
    clientEntityType: caseData.client_entity_type,
    clientAddress: clientAddress || "To be provided",
    clientGstNumber: caseData.client_gst_number,
    clientPanNumber: caseData.client_pan_number,
    clientCinNumber: caseData.client_cin_number,
    clientEmail: caseData.client_email,
    clientPhone: caseData.client_phone,
    lesseeSignatoryName: caseData.represented_by_name || undefined,
    lesseeSignatoryDesignation: caseData.represented_by_designation || undefined,
    lesseeSignatoryIdType: caseData.represented_by_id_type || undefined,
    lesseeSignatoryIdNumber: caseData.represented_by_id_number || undefined,
    locationName: location?.name || "The WorkVilla",
    locationAddress,
    purpose: caseData.purpose,
    rate: caseData.rate,
    tenureMonths: caseData.tenure_months || 12,
    startDate: caseData.start_date || new Date().toISOString(),
    securityDeposit: caseData.security_deposit || 0,
    renewalEscalationPercentage: caseData.renewal_escalation_percentage ?? 0,
  });

  // Generate PDF
  const pdfDoc = generateLeaveLicensePdf(variables);
  const pdfBuffer = Buffer.from(pdfDoc.output("arraybuffer"));

  // Upload to storage (admin client for bucket RLS bypass)
  const adminSupabase = await createAdminClient();
  const storagePath = `case-agreements/${caseId}/${Date.now()}-leave-license.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: "Failed to upload L&L agreement PDF: " + uploadError.message },
      { status: 500 }
    );
  }

  // Create document record
  const { data: docRecord } = await supabase
    .from("documents")
    .insert({
      title: `Leave & License Agreement - ${caseData.client_name}`,
      file_name: `leave-license-${caseId}.pdf`,
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdfBuffer.length,
      category: "case_document",
      uploaded_by: dbUser?.id,
    })
    .select("id")
    .single();

  // Create the agreement record
  const { data: agreement, error: agrError } = await supabase
    .from("case_agreements")
    .insert({
      case_id: caseId,
      template_key: "leave_license",
      type: "leave_license",
      status: "draft",
      variables: variables as unknown as Record<string, unknown>,
      generated_document_id: docRecord?.id,
      valid_from: caseData.start_date,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (agrError) {
    return NextResponse.json(
      { error: "Failed to create L&L agreement: " + agrError.message },
      { status: 500 }
    );
  }

  // Link to case
  if (agreement) {
    await supabase
      .from("cases")
      .update({
        ll_agreement_id: agreement.id,
        ll_agreement_status: "draft",
      })
      .eq("id", caseId);
  }

  // Audit
  if (dbUser?.id && agreement) {
    logAudit(supabase, {
      entityType: "case_agreement",
      entityId: agreement.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: agreement }, type: { old: null, new: "leave_license" } },
    });
  }

  return NextResponse.json({ data: agreement }, { status: 201 });
}

/**
 * PUT: Update L&L agreement variables and regenerate PDF
 */
export async function PUT(
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

  const body = await request.json();
  const agreementId = body.agreement_id as string;
  const updatedVars = body.variables as Record<string, unknown>;

  if (!agreementId) {
    return NextResponse.json({ error: "agreement_id is required" }, { status: 400 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const { data: existingAgreement, error: fetchErr } = await supabase
    .from("case_agreements")
    .select("*")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (fetchErr || !existingAgreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  if (!["draft", "internally_approved"].includes(existingAgreement.status)) {
    return NextResponse.json(
      { error: "Agreement can only be edited in draft or internally approved state" },
      { status: 400 }
    );
  }

  const existingVars = (existingAgreement.variables || {}) as Record<string, unknown>;
  const mergedVars = { ...existingVars, ...updatedVars };

  // Regenerate PDF
  const pdfDoc = generateLeaveLicensePdf(mergedVars as never);
  const pdfBuffer = Buffer.from(pdfDoc.output("arraybuffer"));

  const adminSupabase = await createAdminClient();
  const storagePath = `case-agreements/${caseId}/${Date.now()}-leave-license.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: "Failed to upload regenerated PDF: " + uploadError.message },
      { status: 500 }
    );
  }

  const { data: docRecord } = await supabase
    .from("documents")
    .insert({
      title: `Leave & License Agreement - ${mergedVars.client_name || "Client"}`,
      file_name: `leave-license-${caseId}.pdf`,
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdfBuffer.length,
      category: "case_document",
      uploaded_by: dbUser?.id,
    })
    .select("id")
    .single();

  const { data: updated, error: updateErr } = await supabase
    .from("case_agreements")
    .update({
      variables: mergedVars,
      generated_document_id: docRecord?.id,
      status: "draft",
    })
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  if (updated) {
    await supabase
      .from("cases")
      .update({ ll_agreement_status: "draft" })
      .eq("id", caseId);
  }

  if (dbUser?.id && updated) {
    logAudit(supabase, {
      entityType: "case_agreement",
      entityId: agreementId,
      action: "update",
      performedBy: dbUser.id,
      changes: { action: { old: null, new: "edit_variables" }, variables: { old: existingVars, new: mergedVars } },
    });
  }

  return NextResponse.json({ data: updated });
}

/**
 * PATCH: Update L&L agreement status
 */
export async function PATCH(
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

  const body = await request.json();
  const action = body.action as string;
  const agreementId = body.agreement_id as string;

  if (!agreementId) {
    return NextResponse.json(
      { error: "agreement_id is required" },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "office_admin"];
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to update agreement status" }, { status: 403 });
  }

  const { data: currentAgreement } = await supabase
    .from("case_agreements")
    .select("status")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!currentAgreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  const validTransitions: Record<string, string[]> = {
    approve_internally: ["draft"],
    send_to_client: ["internally_approved"],
    client_approved: ["sent_to_client"],
    initiate_signing: ["client_approved"],
    mark_executed: ["signing", "client_approved"],
  };

  if (validTransitions[action] && !validTransitions[action].includes(currentAgreement.status)) {
    return NextResponse.json(
      { error: `Cannot ${action.replace(/_/g, " ")} — agreement must be in ${validTransitions[action].join(" or ")} status (currently: ${currentAgreement.status})` },
      { status: 400 }
    );
  }

  if (action === "mark_executed") {
    const gateError = await checkVoExecutionPaymentGate(supabase, caseId);
    if (gateError) {
      return NextResponse.json({ error: gateError }, { status: 400 });
    }
  }

  const updateData: Record<string, unknown> = {};

  switch (action) {
    case "approve_internally":
      updateData.status = "internally_approved";
      updateData.internal_approved_by = dbUser?.id;
      updateData.internal_approved_at = new Date().toISOString();
      break;

    case "send_to_client":
      updateData.status = "sent_to_client";
      updateData.sent_to_client_at = new Date().toISOString();
      updateData.sent_to_email = body.email;
      break;

    case "client_approved":
      updateData.status = "client_approved";
      updateData.client_approved_at = new Date().toISOString();
      break;

    case "initiate_signing":
      updateData.status = "signing";
      break;

    case "mark_executed":
      updateData.status = "executed";
      updateData.signed_at = new Date().toISOString();
      break;

    default:
      return NextResponse.json(
        { error: "Invalid action. Valid: approve_internally, send_to_client, client_approved, initiate_signing, mark_executed" },
        { status: 400 }
      );
  }

  const { data, error } = await supabase
    .from("case_agreements")
    .update(updateData)
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (data) {
    await supabase
      .from("cases")
      .update({ ll_agreement_status: data.status })
      .eq("id", caseId);
  }

  if (dbUser?.id && data) {
    logAudit(supabase, {
      entityType: "case_agreement",
      entityId: agreementId,
      action: "update",
      performedBy: dbUser.id,
      changes: { action: { old: null, new: action }, status: { old: null, new: data.status } },
    });
  }

  return NextResponse.json({ data });
}

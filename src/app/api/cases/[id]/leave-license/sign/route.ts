import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  uploadForEStampAndSigning,
  getSigningStatus,
} from "@/lib/leegality";

/**
 * POST: Leegality e-stamp & e-sign operations (user-triggered)
 *   action: 'initiate' — Upload PDF to Leegality for e-stamping + signing
 *   action: 'check_status' — Poll Leegality for current status
 *
 * Leegality webhook callbacks are handled by /api/webhooks/leegality
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

  const body = await request.json();
  const action = body.action as string;
  const agreementId = body.agreement_id as string;

  if (!agreementId) {
    return NextResponse.json({ error: "agreement_id is required" }, { status: 400 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const adminSupabase = await createAdminClient();

  // Fetch the agreement
  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("*, generated_document:documents!case_agreements_generated_document_id_fkey(file_path, file_name)")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  switch (action) {
    case "initiate": {
      if (!["client_approved"].includes(agreement.status)) {
        return NextResponse.json(
          { error: "Agreement must be client approved before initiating e-signing" },
          { status: 400 }
        );
      }

      // Download the PDF from storage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docRaw = agreement.generated_document as any;
      const doc = Array.isArray(docRaw) ? docRaw[0] : docRaw;

      if (!doc?.file_path) {
        return NextResponse.json({ error: "No PDF document found" }, { status: 400 });
      }

      const { data: pdfData, error: dlError } = await adminSupabase.storage
        .from("crm-documents")
        .download(doc.file_path);

      if (dlError || !pdfData) {
        return NextResponse.json({ error: "Failed to download PDF" }, { status: 500 });
      }

      const pdfBuffer = Buffer.from(await pdfData.arrayBuffer());
      const vars = (agreement.variables || {}) as Record<string, string>;

      // Upload to Leegality
      let result;
      try {
        result = await uploadForEStampAndSigning({
          pdfBuffer,
          documentName: `Leave & License - ${vars.client_name || "Client"}`,
          lessorSigner: {
            name: "Naval Chordia",
            email: "naval@theworkvilla.com",
            phone: "+919791097900",
          },
          lesseeSigner: {
            name: vars.lessee_signatory_name || vars.client_name || "Client",
            email: vars.client_email || "",
            phone: vars.client_phone || "",
            signMethod: "aadhaar_esign",
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[ll-sign] Leegality upload error:", message);
        return NextResponse.json(
          { error: `Leegality error: ${message}` },
          { status: 502 }
        );
      }

      // Update agreement with Leegality details
      await supabase
        .from("case_agreements")
        .update({
          status: "signing",
          leegality_document_id: result.documentId,
          leegality_sign_url: result.signUrl,
          leegality_status: result.status,
          leegality_estamp_value: result.stampDutyPaid,
        })
        .eq("id", agreementId);

      // Update case status
      await supabase
        .from("cases")
        .update({ ll_agreement_status: "signing" })
        .eq("id", caseId);

      if (dbUser?.id) {
        logAudit(supabase, {
          entityType: "case_agreement",
          entityId: agreementId,
          action: "update",
          performedBy: dbUser.id,
          changes: {
            action: { old: null, new: "initiate_leegality_signing" },
            leegality_document_id: { old: null, new: result.documentId },
          },
        });
      }

      return NextResponse.json({
        data: {
          documentId: result.documentId,
          signUrl: result.signUrl,
          status: result.status,
          stampDutyPaid: result.stampDutyPaid,
        },
      });
    }

    case "check_status": {
      const docId = agreement.leegality_document_id as string;
      if (!docId) {
        return NextResponse.json({ error: "No Leegality document ID found" }, { status: 400 });
      }

      let status;
      try {
        status = await getSigningStatus(docId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Leegality error: ${message}` }, { status: 502 });
      }

      // Update local status
      await supabase
        .from("case_agreements")
        .update({ leegality_status: status.status })
        .eq("id", agreementId);

      // If completed, mark as executed
      if (status.status === "COMPLETED") {
        await supabase
          .from("case_agreements")
          .update({
            status: "executed",
            signed_at: new Date().toISOString(),
            leegality_status: "COMPLETED",
          })
          .eq("id", agreementId);

        await supabase
          .from("cases")
          .update({ ll_agreement_status: "executed" })
          .eq("id", caseId);
      }

      return NextResponse.json({ data: status });
    }

    default:
      return NextResponse.json(
        { error: "Invalid action. Valid: initiate, check_status" },
        { status: 400 }
      );
  }
}

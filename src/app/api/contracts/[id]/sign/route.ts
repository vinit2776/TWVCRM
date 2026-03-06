import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  uploadForEStampAndSigning,
  getSigningStatus,
} from "@/lib/leegality";

/**
 * POST /api/contracts/[id]/sign
 *
 * Initiates or checks Leegality e-stamp + e-sign for a membership agreement.
 *
 *   action: 'initiate'
 *     - Client sends the generated PDF as base64 (pdf_base64 field)
 *       because jsPDF is browser-only and cannot run server-side.
 *     - Server uploads it to Leegality with stamp + two signers.
 *
 *   action: 'check_status'
 *     - Polls Leegality for the current signing status.
 *
 * Webhook callbacks are handled by /api/webhooks/leegality (HMAC-authenticated).
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
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const body = await request.json();
  const action = body.action as string;

  // Fetch the contract
  const { data: contract } = await supabase
    .from("contracts")
    .select(
      "*, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)"
    )
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  switch (action) {
    case "initiate": {
      if (["rejected", "terminated", "completed"].includes(contract.status)) {
        return NextResponse.json(
          { error: "Cannot initiate e-signing on a rejected, terminated, or completed contract" },
          { status: 400 }
        );
      }

      // The PDF is generated on the client (jsPDF is browser-only)
      // and sent here as base64
      const pdfBase64 = body.pdf_base64 as string;
      if (!pdfBase64) {
        return NextResponse.json(
          { error: "pdf_base64 is required" },
          { status: 400 }
        );
      }

      const pdfBuffer = Buffer.from(pdfBase64, "base64");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = contract.lead as any;
      const memberName =
        lead?.company ||
        `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() ||
        "Member";
      const memberEmail = lead?.email ?? "";
      const memberPhone = lead?.mobile ?? lead?.phone ?? "";
      const signatoryName = contract.member_signatory_name || memberName;

      const result = await uploadForEStampAndSigning({
        pdfBuffer,
        documentName: `Membership Agreement - ${memberName}`,
        stampState: "Tamil Nadu",
        stampDutyValue: 300,
        lessorSigner: {
          name: "Naval Chordia",
          email: "naval@theworkvilla.com",
          phone: "+919791097900",
        },
        lesseeSigner: {
          name: signatoryName,
          email: memberEmail,
          phone: memberPhone,
          signMethod: "aadhaar_esign",
        },
      });

      // Store Leegality details on the contract
      await supabase
        .from("contracts")
        .update({
          leegality_document_id: result.documentId,
          leegality_sign_url: result.signUrl,
          leegality_status: result.status,
        })
        .eq("id", contractId);

      if (dbUser?.id) {
        logAudit(supabase, {
          entityType: "contract",
          entityId: contractId,
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
        },
      });
    }

    case "check_status": {
      const docId = contract.leegality_document_id as string;
      if (!docId) {
        return NextResponse.json(
          { error: "No Leegality document ID found — initiate signing first" },
          { status: 400 }
        );
      }

      const status = await getSigningStatus(docId);

      const update: Record<string, unknown> = { leegality_status: status.status };
      if (status.status === "COMPLETED") {
        update.signed_at = new Date().toISOString();
      }

      await supabase.from("contracts").update(update).eq("id", contractId);

      return NextResponse.json({ data: status });
    }

    default:
      return NextResponse.json(
        { error: "Invalid action. Valid: initiate, check_status" },
        { status: 400 }
      );
  }
}

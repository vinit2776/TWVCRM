import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { buildAddendumPdfBuffer } from "@/lib/addendum-generator";
import {
  uploadForEStampAndSigning,
  getSigningStatus,
} from "@/lib/leegality";

/**
 * Leegality only accepts a single file per envelope, so for renewal
 * contracts the addendum's pages are appended onto the base agreement
 * before upload — the client signs one combined document covering both.
 */
async function appendAddendumIfRenewal(
  supabase: SupabaseClient,
  contractId: string,
  baseBuffer: Buffer
): Promise<Buffer> {
  const addendumBuffer = await buildAddendumPdfBuffer(supabase, contractId);
  if (!addendumBuffer) return baseBuffer;

  const merged = await PDFDocument.create();
  for (const buf of [baseBuffer, addendumBuffer]) {
    const doc = await PDFDocument.load(buf);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  return Buffer.from(await merged.save());
}

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

      const baseBuffer = Buffer.from(pdfBase64, "base64");
      const pdfBuffer = await appendAddendumIfRenewal(supabase, contractId, baseBuffer);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = contract.lead as any;
      const memberName =
        lead?.company ||
        `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() ||
        "Member";
      const memberEmail = (lead?.email ?? "").trim();
      const memberPhone = (lead?.mobile ?? lead?.phone ?? "").trim();
      const signatoryName = contract.member_signatory_name || memberName;

      // Validate required signer details
      if (!memberEmail) {
        return NextResponse.json(
          { error: "Lead email is required for e-signing. Please add an email to the lead first." },
          { status: 400 }
        );
      }
      if (!signatoryName || signatoryName === "Member") {
        return NextResponse.json(
          { error: "Signatory name is required. Set the member signatory name on the contract." },
          { status: 400 }
        );
      }

      console.log("[contract/sign] Initiating for:", {
        contractId,
        signatoryName,
        memberEmail,
        memberPhone: memberPhone ? "***" : "(empty)",
        contractNumber: contract.contract_number,
      });

      let result;
      try {
        result = await uploadForEStampAndSigning({
          pdfBuffer,
          documentName: `Membership Agreement - ${memberName}`,
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[contract/sign] Leegality upload error:", message);
        return NextResponse.json(
          { error: `Leegality error: ${message}` },
          { status: 502 }
        );
      }

      // Store Leegality details on the contract
      await supabase
        .from("contracts")
        .update({
          leegality_document_id: result.documentId,
          leegality_sign_url: result.signUrls[0] ?? result.signUrl,       // Lessor (Naval)
          leegality_lessee_sign_url: result.signUrls[1] ?? null,          // Customer
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

      if (contract.lead_id) {
        supabase
          .from("activities")
          .insert({
            lead_id: contract.lead_id,
            type: "note",
            subject: "📝 Sent for e-Signing via Leegality",
            description: `Membership agreement ${contract.contract_number} sent to ${signatoryName} (${memberEmail}) for e-signature.`,
            created_by: dbUser?.id ?? null,
          })
          .then(({ error }) => {
            if (error) console.error("[contract/sign] Failed to log activity:", error.message);
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

      let status;
      try {
        status = await getSigningStatus(docId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Leegality error: ${message}` }, { status: 502 });
      }

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

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyWebhookSignature, parseWebhookPayload, downloadStampedDocument } from "@/lib/leegality";
import { checkVoExecutionPaymentGate } from "@/lib/vo-execution-gate";
import { advanceCaseOnAgreementExecuted } from "@/lib/case-status-events";

/**
 * Fetch the signed PDF from Leegality and store it in crm-documents.
 * Returns the new documents.id, or null if the download/upload failed —
 * callers must not let this block the signing-status update, since the
 * document itself already exists at Leegality even if our copy fails.
 */
async function storeSignedDocument(
  adminSupabase: SupabaseClient,
  params: {
    documentId: string;
    title: string;
    storagePathPrefix: string;
  }
): Promise<{ documentRecordId: string | null; error: string | null }> {
  try {
    const { pdfBase64, fileName } = await downloadStampedDocument(params.documentId);
    if (!pdfBase64) {
      return { documentRecordId: null, error: "Leegality returned an empty document" };
    }

    const fileBuffer = Buffer.from(pdfBase64, "base64");
    const storagePath = `${params.storagePathPrefix}/leegality-signed-${Date.now()}.pdf`;

    const { error: uploadError } = await adminSupabase.storage
      .from("crm-documents")
      .upload(storagePath, fileBuffer, {
        contentType: "application/pdf",
        upsert: false,
      });
    if (uploadError) {
      return { documentRecordId: null, error: `Storage upload failed: ${uploadError.message}` };
    }

    const { data: docRecord, error: insertError } = await adminSupabase
      .from("documents")
      .insert({
        title: params.title,
        file_name: fileName,
        file_path: storagePath,
        mime_type: "application/pdf",
        size_bytes: fileBuffer.length,
        category: "contract_document",
      })
      .select("id")
      .single();
    if (insertError) {
      return { documentRecordId: null, error: `documents insert failed: ${insertError.message}` };
    }

    return { documentRecordId: docRecord.id, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { documentRecordId: null, error: `Document fetch failed: ${message}` };
  }
}

/**
 * POST /api/webhooks/leegality
 *
 * Receives signing completion callbacks from Leegality.
 * This is a public endpoint (no user auth) — Leegality calls it directly.
 * The request is authenticated via HMAC-SHA256 signature in the
 * X-Leegality-Signature header, computed with LEEGALITY_PRIVATE_SALT.
 *
 * Configure this URL in the Leegality dashboard as the webhook endpoint.
 *
 * Payload shape is not guaranteed — parseWebhookPayload() applies the same
 * camelCase/snake_case/data-envelope fallbacks used elsewhere in lib/leegality.ts.
 *
 * Every call is logged to leegality_webhook_log (see migration 00348) so a
 * missing or malformed callback can be diagnosed after the fact instead of
 * only showing up in console output.
 */
export async function POST(request: NextRequest) {
  const adminSupabase = await createAdminClient();

  // Read raw body first — required for HMAC verification
  const rawBody = await request.text();
  const signature = request.headers.get("x-leegality-signature") ?? "";
  const signatureValid = verifyWebhookSignature(rawBody, signature);

  const logEvent = (
    fields: Partial<{
      document_id: string | null;
      status: string | null;
      outcome: string;
      outcome_detail: string;
      raw_payload: unknown;
    }>
  ) =>
    adminSupabase.from("leegality_webhook_log").insert({
      signature_valid: signatureValid,
      ...fields,
    });

  if (!signatureValid) {
    console.error("[Leegality Webhook] Invalid signature — rejecting request.");
    await logEvent({ outcome: "error", outcome_detail: "Invalid signature" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await logEvent({ outcome: "error", outcome_detail: "Invalid JSON" });
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { documentId, status } = parseWebhookPayload(payload);

  if (!documentId) {
    await logEvent({
      outcome: "error",
      outcome_detail: "Missing document_id",
      raw_payload: payload,
    });
    return NextResponse.json({ error: "Missing document_id" }, { status: 400 });
  }

  // Look up the agreement by Leegality document ID
  const { data: agreement } = await adminSupabase
    .from("case_agreements")
    .select("id, case_id, type")
    .eq("leegality_document_id", documentId)
    .maybeSingle();

  // Look up contracts (membership agreements) by Leegality document ID
  const { data: contract } = await adminSupabase
    .from("contracts")
    .select("id, lead_id, contract_number")
    .eq("leegality_document_id", documentId)
    .maybeSingle();

  if (!agreement && !contract) {
    // Could be a document from another context — ack and move on
    console.warn(`[Leegality Webhook] No record found for document_id: ${documentId}`);
    await logEvent({
      document_id: documentId,
      status,
      outcome: "ignored",
      outcome_detail: "No matching contract or case_agreement",
      raw_payload: payload,
    });
    return NextResponse.json({ received: true });
  }

  const documentNotes: string[] = [];

  if (status === "COMPLETED") {
    const now = new Date().toISOString();

    // Update L&L case agreement
    if (agreement) {
      const { documentRecordId, error: docError } = await storeSignedDocument(adminSupabase, {
        documentId,
        title: `${agreement.type === "leave_license" ? "Leave & License Agreement" : "Agreement"} — Signed via Leegality`,
        storagePathPrefix: `case-agreements/${agreement.case_id}`,
      });
      if (docError) {
        console.error(`[Leegality Webhook] Failed to store signed document for agreement ${agreement.id}:`, docError);
        documentNotes.push(`case_agreement document store failed: ${docError}`);
      }

      // Prepaid/direct-client cases require a paid VO invoice before the
      // agreement can execute — same gate as every other mark-executed path
      // (src/lib/vo-execution-gate.ts). The customer already e-signed via
      // Leegality by this point, so we still record that (leegality_status,
      // signed document) but hold status at its current value instead of
      // flipping to 'executed' — accounts can complete it manually once
      // payment lands. Ack 200 regardless so Leegality doesn't retry.
      const gateError = agreement.type === "leave_license"
        ? await checkVoExecutionPaymentGate(adminSupabase, agreement.case_id)
        : null;

      await adminSupabase
        .from("case_agreements")
        .update({
          ...(gateError ? {} : { status: "executed", signed_at: now }),
          leegality_status: "COMPLETED",
          ...(documentRecordId ? { generated_document_id: documentRecordId } : {}),
        })
        .eq("id", agreement.id);

      if (gateError) {
        console.warn(`[Leegality Webhook] L&L agreement ${agreement.id} e-signed but held (unpaid): ${gateError}`);
        documentNotes.push(`Signed via Leegality but not marked executed — invoice unpaid`);
      } else {
        await adminSupabase
          .from("cases")
          .update({ ll_agreement_status: "executed" })
          .eq("id", agreement.case_id);

        await advanceCaseOnAgreementExecuted(adminSupabase, agreement.case_id);

        console.log(`[Leegality Webhook] L&L agreement ${agreement.id} marked executed.`);
      }
    }

    // Update membership contract
    if (contract) {
      const { documentRecordId, error: docError } = await storeSignedDocument(adminSupabase, {
        documentId,
        title: `Membership Agreement ${contract.contract_number} — Signed via Leegality`,
        storagePathPrefix: `contracts/${contract.id}`,
      });
      if (docError) {
        console.error(`[Leegality Webhook] Failed to store signed document for contract ${contract.id}:`, docError);
        documentNotes.push(`contract document store failed: ${docError}`);
      }

      await adminSupabase
        .from("contracts")
        .update({
          leegality_status: "COMPLETED",
          signed_at: now,
          ...(documentRecordId ? { signed_document_id: documentRecordId } : {}),
        })
        .eq("id", contract.id);

      console.log(`[Leegality Webhook] Contract ${contract.id} marked signed.`);

      if (contract.lead_id) {
        await adminSupabase.from("activities").insert({
          lead_id: contract.lead_id,
          type: "note",
          subject: "✅ Agreement Signed via Leegality",
          description: documentRecordId
            ? `Membership agreement ${contract.contract_number} has been fully signed. Signed copy stored on the contract.`
            : `Membership agreement ${contract.contract_number} has been fully signed. (Signed PDF could not be retrieved from Leegality — check the contract for the sign status and retry downloading manually.)`,
        });
      }
    }
  } else if (status === "EXPIRED" || status === "CANCELLED") {
    // Mark as signing failed so staff can re-initiate
    if (agreement) {
      await adminSupabase
        .from("case_agreements")
        .update({ leegality_status: status })
        .eq("id", agreement.id);
    }
    if (contract) {
      await adminSupabase
        .from("contracts")
        .update({ leegality_status: status })
        .eq("id", contract.id);

      if (contract.lead_id) {
        await adminSupabase.from("activities").insert({
          lead_id: contract.lead_id,
          type: "note",
          subject: status === "EXPIRED" ? "⚠️ e-Signing Expired" : "⚠️ e-Signing Cancelled",
          description: `Leegality signing request for membership agreement ${contract.contract_number} was ${status.toLowerCase()}. Re-send for e-signing to continue.`,
        });
      }
    }
  }

  await logEvent({
    document_id: documentId,
    status,
    outcome: "processed",
    outcome_detail: [
      agreement ? `case_agreement:${agreement.id}` : null,
      contract ? `contract:${contract.id}` : null,
      ...documentNotes,
    ]
      .filter(Boolean)
      .join(", "),
    raw_payload: payload,
  });

  return NextResponse.json({ received: true });
}

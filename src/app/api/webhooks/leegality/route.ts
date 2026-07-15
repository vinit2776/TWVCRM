import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyWebhookSignature, parseWebhookPayload } from "@/lib/leegality";

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
    .select("id, lead_id")
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

  if (status === "COMPLETED") {
    const now = new Date().toISOString();

    // Update L&L case agreement
    if (agreement) {
      await adminSupabase
        .from("case_agreements")
        .update({
          status: "executed",
          signed_at: now,
          leegality_status: "COMPLETED",
        })
        .eq("id", agreement.id);

      await adminSupabase
        .from("cases")
        .update({ ll_agreement_status: "executed" })
        .eq("id", agreement.case_id);

      console.log(`[Leegality Webhook] L&L agreement ${agreement.id} marked executed.`);
    }

    // Update membership contract
    if (contract) {
      await adminSupabase
        .from("contracts")
        .update({
          leegality_status: "COMPLETED",
          signed_at: now,
        })
        .eq("id", contract.id);

      console.log(`[Leegality Webhook] Contract ${contract.id} marked signed.`);
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
    }
  }

  await logEvent({
    document_id: documentId,
    status,
    outcome: "processed",
    outcome_detail: [
      agreement ? `case_agreement:${agreement.id}` : null,
      contract ? `contract:${contract.id}` : null,
    ]
      .filter(Boolean)
      .join(", "),
    raw_payload: payload,
  });

  return NextResponse.json({ received: true });
}

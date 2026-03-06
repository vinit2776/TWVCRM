import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyWebhookSignature } from "@/lib/leegality";

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
 * Expected payload:
 *   { document_id: string, status: "COMPLETED" | "EXPIRED" | ..., ... }
 */
export async function POST(request: NextRequest) {
  // Read raw body first — required for HMAC verification
  const rawBody = await request.text();
  const signature = request.headers.get("x-leegality-signature") ?? "";

  // Verify HMAC signature
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.error("[Leegality Webhook] Invalid signature — rejecting request.");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const documentId = payload.document_id as string;
  const status = (payload.status as string)?.toUpperCase();

  if (!documentId) {
    return NextResponse.json({ error: "Missing document_id" }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();

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

  return NextResponse.json({ received: true });
}

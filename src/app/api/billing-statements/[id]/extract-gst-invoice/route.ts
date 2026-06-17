import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { extractFromPdf } from "@/lib/tally-pdf-extract";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";
import { isInboxRole, type ExtractResponse } from "@/lib/tally-handoff";

/**
 * POST /api/billing-statements/[id]/extract-gst-invoice
 *
 * Server-side autofill cascade. Receives a PDF (the file accounts just
 * picked), runs the extraction pipeline, and returns the fields. The
 * upload form uses this to prefill itself so accounts reviews instead
 * of types.
 *
 * Cascade:
 *   1. PDF text parse via pdf-parse  (catches ~85-95% of Tally exports)
 *   2. Bridge match — if the extracted invoice_number is present in
 *      tally_voucher_snapshots, mark `bridge_match: true` so the UI
 *      can show "matched in Tally" badge. Doesn't override extracted
 *      fields; just adds confidence.
 *   3. Browser-side QR scan (deferred to a follow-up — pdfjs-dist
 *      bundle is too heavy to ship without measuring first).
 *
 * This endpoint never persists anything. It's a read-only helper for
 * the upload form. The actual gst_invoice_uploads INSERT still goes
 * through /upload-gst-invoice.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: _statementId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser || !isInboxRole(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  // ── Parse multipart body ─────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Could not parse upload" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.type !== "application/pdf") {
    // Image uploads can't be text-parsed without OCR. Return empty so the
    // form falls back to manual entry without erroring.
    const response: ExtractResponse = {
      source: "manual",
      fields: {},
      raw_text_snippet: null,
      bridge_match: false,
    };
    return NextResponse.json(response);
  }

  // 50MB cap — same as the upload endpoint.
  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (>50MB)" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // ── Layer 1: PDF text parse ──────────────────────────────────────────────
  const parsed = await extractFromPdf(buffer);

  // ── Layer 2: Bridge match cross-check ────────────────────────────────────
  // If we extracted an invoice number, see if the read-only bridge has
  // already snapshotted that voucher. Confirms the PDF matches Tally.
  let bridgeMatch = false;
  if (parsed.fields.invoice_number) {
    const { data: snap } = await supabase
      .from("tally_voucher_snapshots")
      .select("voucher_master_id")
      .eq("invoice_number", parsed.fields.invoice_number)
      .limit(1)
      .maybeSingle();
    bridgeMatch = !!snap;
  }

  // If text parse failed entirely (e.g. scanned image PDF) but we have a
  // bridge match by some other path, the source label is bridge_match;
  // otherwise pdf_text or manual.
  const source = parsed.source === "manual" && bridgeMatch
    ? "bridge_match"
    : parsed.source;

  const response: ExtractResponse = {
    source,
    fields: parsed.fields,
    raw_text_snippet: parsed.raw_text_snippet,
    bridge_match: bridgeMatch,
  };

  return NextResponse.json(response);
}

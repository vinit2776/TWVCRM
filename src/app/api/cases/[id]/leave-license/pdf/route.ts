import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { applyDraftWatermark } from "@/lib/draft-watermark";
import { resolveWatermark } from "@/lib/agreement-watermark-server";
import { logAudit } from "@/lib/audit";

/**
 * GET /api/cases/[id]/leave-license/pdf
 *
 * Streams the Leave & License agreement, watermarked DRAFT until the company
 * stamp and seal have been applied (or the agreement has otherwise executed).
 *
 * This exists instead of handing out a signed storage URL — which is what the
 * parent route's `pdf_url` still does — because the watermark has to be
 * composited on the way out. The stored object stays clean: `../sign` sends
 * that exact file to Leegality for e-signature and `../manual-sign` uploads a
 * countersigned copy of it, so a watermark baked into storage would end up
 * permanently on executed agreements.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  const { data: agreement } = await adminSupabase
    .from("case_agreements")
    .select(
      "id, status, signed_document_id, stamp_reference, " +
      "generated_document:documents!case_agreements_generated_document_id_fkey(file_path, file_name), " +
      "signed_document:documents!case_agreements_signed_document_id_fkey(file_path, file_name)"
    )
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!agreement) {
    return NextResponse.json({ error: "No leave & license agreement found" }, { status: 404 });
  }

  // The generated/signed document joins come back loosely typed from the
  // string-built select above.
  const row = agreement as unknown as {
    status: string | null;
    signed_document_id: string | null;
    stamp_reference: string | null;
    generated_document: { file_path: string; file_name: string } | { file_path: string; file_name: string }[] | null;
    signed_document: { file_path: string; file_name: string } | { file_path: string; file_name: string }[] | null;
  };

  const first = <T,>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

  // Once a signed/stamped copy exists it is the document of record; the
  // unstamped original is only served while none does.
  const signed = first(row.signed_document);
  const generated = first(row.generated_document);
  const doc = signed ?? generated;

  if (!doc?.file_path) {
    return NextResponse.json({ error: "No PDF has been generated for this agreement" }, { status: 404 });
  }

  const { data: file, error: dlError } = await adminSupabase.storage
    .from("crm-documents")
    .download(doc.file_path);

  if (dlError || !file) {
    return NextResponse.json({ error: "Failed to read the agreement PDF" }, { status: 500 });
  }

  // ?watermark=0 asks for a clean copy. Whether it gets one is decided here,
  // not by the caller — the checkbox in the UI is a request, this is the answer.
  const requestedClean = request.nextUrl.searchParams.get("watermark") === "0";

  const { data: caseRow } = await adminSupabase
    .from("cases")
    .select("id, aggregator_id, aggregator:aggregators!cases_aggregator_id_fkey(billing_method)")
    .eq("id", caseId)
    .maybeSingle();

  const decision = await resolveWatermark({
    admin: adminSupabase,
    caseId,
    caseRow: (caseRow ?? {}) as { aggregator_id?: string | null; aggregator?: { billing_method?: string | null } | null },
    agreement: row,
    requestedClean,
  });

  const original = new Uint8Array(await file.arrayBuffer());
  const draft = decision.applyWatermark;
  const bytes = draft ? await applyDraftWatermark(original) : original;

  const name = draft
    ? `DRAFT-${doc.file_name || `leave-license-${caseId}.pdf`}`
    : doc.file_name || `leave-license-${caseId}.pdf`;

  // A clean, unexecuted agreement is exactly what the watermark exists to stop
  // circulating unmarked — so when one is released, record who did it.
  if (!draft && !decision.settled) {
    const { data: dbUser } = await supabase
      .from("users").select("id").eq("auth_id", user.id).single();
    if (dbUser) {
      logAudit(supabase, {
        entityType: "case",
        entityId: caseId,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          agreement_clean_copy_released: {
            old: "watermarked",
            new: `clean copy downloaded (${decision.route} billing)`,
          },
        },
      });
    }
  }

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      // Draft status changes as the agreement progresses, so this must not be
      // cached — a stale clean copy would defeat the whole safeguard.
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}

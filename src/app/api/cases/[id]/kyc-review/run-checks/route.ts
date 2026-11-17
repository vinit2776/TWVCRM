import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { autoFlags, maskAadhaar } from "@/lib/vo-kyc-validators";
import { validatePortalCheck } from "@/lib/vo-kyc-review";
import { KYC_PORTAL_CHECK_RESULTS, KYC_PORTAL_CHECK_TYPES } from "@/lib/constants";
import { UUID_RE, NOT_MIGRATED, authoriseKyc, kycReviewPresent, loadKycState } from "@/lib/vo-kyc-review-server";
import type { EntityType } from "@/types";

/**
 * POST /api/cases/[id]/kyc-review/run-checks — step 1.
 * Runs the automatic flags over the case's KYC details plus whatever the
 * preparer read off the documents, and records portal checks. Full Aadhaar is
 * used in memory only; at most the masked form is stored.
 * Running again replaces the flags and clears any earlier sign-off.
 */
const optional = z.string().trim().max(200).optional();

const bodySchema = z.object({
  mca_name: optional,
  signatory_name: optional,
  signatory_pan: optional,
  signatory_aadhaar: optional,
  certificate_issued_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** case_documents row the signatory/certificate details were read from. */
  document_id: z.string().regex(UUID_RE).optional(),
  portal_checks: z
    .array(
      z.object({
        check_type: z.enum(KYC_PORTAL_CHECK_TYPES),
        result: z.enum(KYC_PORTAL_CHECK_RESULTS),
        evidence_note: z.string().trim().max(1000).optional(),
      }),
    )
    .max(KYC_PORTAL_CHECK_TYPES.length)
    .default([]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authoriseKyc({ need: "prepare" });
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const body = parsed.data;
  for (const pc of body.portal_checks) {
    const problem = validatePortalCheck(pc);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  if (!(await kycReviewPresent())) return NOT_MIGRATED();

  const admin = await createAdminClient();
  const before = await loadKycState(admin, id);
  if (!before) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const c = before.row;

  const flags = autoFlags({
    entityType: c.client_entity_type as EntityType,
    companyName: c.client_company_name || c.client_name,
    mcaName: body.mca_name,
    companyPan: c.client_pan_number ?? undefined,
    gstin: c.client_gst_number ?? undefined,
    signatoryName: body.signatory_name,
    signatoryPan: body.signatory_pan,
    signatoryAadhaar: body.signatory_aadhaar,
    cin: c.client_cin_number ?? undefined,
    certificateIssuedOn: body.certificate_issued_on,
  });

  const now = new Date().toISOString();

  if (body.document_id) {
    const { error: docErr } = await admin
      .from("case_documents")
      .update({
        auto_flags: flags,
        extracted_name: body.signatory_name || body.mca_name || null,
        extracted_id_masked: body.signatory_aadhaar ? maskAadhaar(body.signatory_aadhaar) : null,
        extracted_issued_on: body.certificate_issued_on ?? null,
      })
      .eq("id", body.document_id)
      .eq("case_id", id);
    if (docErr) return NextResponse.json({ error: docErr.message }, { status: 500 });
  }

  if (body.portal_checks.length > 0) {
    const { error: pcErr } = await admin.from("case_kyc_portal_checks").insert(
      body.portal_checks.map((pc) => ({
        case_id: id,
        check_type: pc.check_type,
        result: pc.result,
        evidence_note: pc.evidence_note || null,
        checked_by: dbUser.id,
        checked_at: now,
      })),
    );
    if (pcErr) return NextResponse.json({ error: pcErr.message }, { status: 500 });
  }

  const { error } = await admin
    .from("cases")
    .update({
      kyc_flags: flags,
      kyc_checks_run_at: now,
      kyc_checks_run_by: dbUser.id,
      kyc_signoff_acks: null,
      kyc_reviewed_at: null,
      kyc_reviewed_by: null,
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      kyc_checks_run: {
        old: before.row.kyc_checks_run_at,
        new: now,
      },
      kyc_flag_codes: {
        old: (before.row.kyc_flags ?? []).map((f) => f.code),
        new: flags.map((f) => f.code),
      },
      kyc_portal_checks: {
        old: null,
        new: body.portal_checks.map((p) => `${p.check_type}:${p.result}`),
      },
    },
  });

  const after = await loadKycState(admin, id);
  return NextResponse.json({
    data: { step: after?.step, flags, warnings: after?.warnings ?? [] },
  });
}

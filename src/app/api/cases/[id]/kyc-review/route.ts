import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { canPrepareKyc, canSignOffKyc, latestPortalChecks } from "@/lib/vo-kyc-review";
import { UUID_RE, authoriseKyc, kycReviewPresent, loadKycState } from "@/lib/vo-kyc-review-server";

/**
 * GET /api/cases/[id]/kyc-review — current state of the two-step KYC review.
 * Returns { available: false } while the migration has not been applied, so the
 * panel can hide itself instead of erroring.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authoriseKyc({ need: "view" });
  if ("error" in auth) return auth.error;

  if (!(await kycReviewPresent())) return NextResponse.json({ data: { available: false } });

  const admin = await createAdminClient();
  const state = await loadKycState(admin, id);
  if (!state) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  return NextResponse.json({
    data: {
      available: true,
      step: state.step,
      checks_run_at: state.row.kyc_checks_run_at,
      reviewed_at: state.row.kyc_reviewed_at,
      flags: state.row.kyc_flags ?? [],
      warnings: state.warnings,
      portal_checks: latestPortalChecks(state.portalChecks),
      acks: state.row.kyc_signoff_acks ?? [],
      can_prepare: canPrepareKyc(auth.dbUser.role),
      can_sign_off: canSignOffKyc(auth.dbUser.role),
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { checkSignoff, relevantAcks } from "@/lib/vo-kyc-review";
import { UUID_RE, NOT_MIGRATED, authoriseKyc, kycReviewPresent, loadKycState } from "@/lib/vo-kyc-review-server";

/**
 * POST /api/cases/[id]/kyc-review/sign-off — step 2 (admin or manager).
 * Warnings do not block, but each one needs an acknowledgement with a reason
 * before kyc_reviewed_at is set.
 */
const bodySchema = z.object({
  acks: z
    .array(z.object({ code: z.string().trim().min(1).max(100), reason: z.string().trim().max(1000) }))
    .max(50)
    .default([]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authoriseKyc({ need: "signoff" });
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  if (!(await kycReviewPresent())) return NOT_MIGRATED();

  const admin = await createAdminClient();
  const state = await loadKycState(admin, id);
  if (!state) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const check = checkSignoff(state.snapshot, parsed.data.acks);
  if (!check.ok) {
    return NextResponse.json({ error: check.error, missing: check.missing }, { status: 422 });
  }

  const acks = relevantAcks(state.snapshot, parsed.data.acks);
  const now = new Date().toISOString();
  const { error } = await admin
    .from("cases")
    .update({ kyc_signoff_acks: acks, kyc_reviewed_at: now, kyc_reviewed_by: dbUser.id })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      kyc_reviewed_at: { old: state.row.kyc_reviewed_at, new: now },
      kyc_signoff_acks: { old: null, new: acks },
    },
  });

  return NextResponse.json({ data: { step: "reviewed", reviewed_at: now } });
}

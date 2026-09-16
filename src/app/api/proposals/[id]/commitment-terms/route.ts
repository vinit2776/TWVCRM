import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasCommitmentTerms, PROPOSAL_MAX_TENURE_MONTHS, validateCommitmentTerms } from "@/lib/proposal-terms";
import { RECORD_COMMITMENT_TERMS_ROLES } from "@/lib/contract-commitment";

/**
 * POST /api/proposals/[id]/commitment-terms
 *
 * Records the term / lock-in / notice period agreed with the customer on a
 * proposal created before these were captured as fields. Such a proposal
 * can't be edited any more once accepted, yet POST /api/contracts refuses to
 * create a contract from it without them — this is the one-time backfill.
 *
 * Only allowed while all three are still empty; once recorded they're locked
 * like any other proposal's. The proposal's stored terms_and_conditions text
 * is left exactly as the customer received it.
 *
 * Body: { tenure_months, lock_in_months, notice_period_months, note }
 */
const schema = z.object({
  tenure_months: z.number().int().min(1).max(PROPOSAL_MAX_TENURE_MONTHS),
  lock_in_months: z.number().int().min(1).max(PROPOSAL_MAX_TENURE_MONTHS),
  notice_period_months: z.number().int().min(0).max(PROPOSAL_MAX_TENURE_MONTHS),
  note: z.string().trim().min(10, "Say where these terms were agreed (e.g. signed proposal, email of 12 Sep)"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !(RECORD_COMMITMENT_TERMS_ROLES as readonly string[]).includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins, managers and sales reps can record agreed terms." }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { note, ...terms } = parsed.data;
  const invalid = validateCommitmentTerms(terms);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const { data: proposal } = await supabase
    .from("proposals")
    .select("id, tenure_months, lock_in_months, notice_period_months")
    .eq("id", id)
    .single();
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  if (hasCommitmentTerms(proposal)) {
    return NextResponse.json({ error: "This proposal already has agreed terms recorded." }, { status: 409 });
  }

  // The null filters make this a compare-and-set: a concurrent recording can't
  // overwrite terms someone else just saved.
  const { data, error } = await supabase
    .from("proposals")
    .update(terms)
    .eq("id", id)
    .is("tenure_months", null)
    .is("lock_in_months", null)
    .is("notice_period_months", null)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "This proposal already has agreed terms recorded." }, { status: 409 });

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "commitment_terms_recorded",
    performedBy: dbUser.id,
    changes: {
      tenure_months: { old: null, new: terms.tenure_months },
      lock_in_months: { old: null, new: terms.lock_in_months },
      notice_period_months: { old: null, new: terms.notice_period_months },
      note: { old: null, new: note },
    },
  });

  return NextResponse.json({ data });
}

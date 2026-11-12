import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resolveWatermark } from "@/lib/agreement-watermark-server";

/**
 * GET /api/cases/[id]/leave-license/watermark-policy
 *
 * Drives the checkbox: whether it is ticked, whether it can be unticked, and
 * the reason to show beside it. The tab asks once and applies the answer to
 * View, Download and Send alike, so the three cannot disagree.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createAdminClient();

  const { data: caseRow } = await admin
    .from("cases")
    .select("id, aggregator_id, aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method)")
    .eq("id", caseId)
    .maybeSingle();
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const { data: agreement } = await admin
    .from("case_agreements")
    .select("id, status, signed_document_id, stamp_reference")
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!agreement) {
    return NextResponse.json({ error: "No leave & license agreement found" }, { status: 404 });
  }

  const decision = await resolveWatermark({
    admin,
    caseId,
    caseRow: caseRow as { aggregator_id?: string | null; aggregator?: { billing_method?: string | null } | null },
    agreement,
  });

  return NextResponse.json({
    data: {
      route: decision.route,
      forced: decision.forced,
      settled: decision.settled,
      reason: decision.reason,
      aggregatorName:
        (caseRow as { aggregator?: { name?: string | null } | null }).aggregator?.name ?? null,
    },
  });
}

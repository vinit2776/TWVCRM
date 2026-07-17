import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/contracts/[id]/deposit-adjustments — full history for the
 * contract-page section (requested/approved/rejected/reversed), newest first.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("deposit_adjustments")
    .select(
      `*,
      requester:users!deposit_adjustments_requested_by_fkey(id, full_name),
      approver:users!deposit_adjustments_approved_by_fkey(id, full_name),
      rejecter:users!deposit_adjustments_rejected_by_fkey(id, full_name),
      reverser:users!deposit_adjustments_reversed_by_fkey(id, full_name)`
    )
    .eq("contract_id", contractId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

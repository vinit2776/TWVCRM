import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/contracts/[id]/vouchers/[issuanceId]
 * Update seat_occupant_email for a voucher issuance
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; issuanceId: string }> }
) {
  const { id, issuanceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { seat_occupant_email } = body as { seat_occupant_email?: string };

  // Validate the issuance belongs to this contract
  const { data: issuance, error: fetchError } = await supabase
    .from("voucher_issuances")
    .select("id, contract_id")
    .eq("id", issuanceId)
    .eq("contract_id", id)
    .single();

  if (fetchError || !issuance) {
    return NextResponse.json({ error: "Issuance not found" }, { status: 404 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("voucher_issuances")
    .update({ seat_occupant_email: seat_occupant_email || null })
    .eq("id", issuanceId)
    .select("*")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ data: updated });
}

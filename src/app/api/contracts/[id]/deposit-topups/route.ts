import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/contracts/[id]/deposit-topups — full top-up history for the
 * contract page (pending/paid/reversed), newest first.
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
    .from("deposit_topups")
    .select(
      `*,
      creator:users!deposit_topups_created_by_fkey(id, full_name),
      reverser:users!deposit_topups_reversed_by_fkey(id, full_name),
      canceller:users!deposit_topups_cancelled_by_fkey(id, full_name)`
    )
    .eq("contract_id", contractId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Joined = {
    creator?: { full_name: string } | null;
    reverser?: { full_name: string } | null;
    canceller?: { full_name: string } | null;
  };
  const flattened = (data as Joined[] | null)?.map((row) => ({
    ...row,
    created_by_name: row.creator?.full_name ?? null,
    reversed_by_name: row.reverser?.full_name ?? null,
    cancelled_by_name: row.canceller?.full_name ?? null,
  }));

  return NextResponse.json({ data: flattened });
}

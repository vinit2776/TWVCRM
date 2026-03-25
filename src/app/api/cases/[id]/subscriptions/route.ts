import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — returns the full subscription chain for a case:
// the root case + all renewals (cases where parent_case_id = root)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch the requested case first to determine root
  const { data: thisCase, error: caseError } = await supabase
    .from("cases")
    .select("id, parent_case_id, is_renewal")
    .eq("id", id)
    .single();

  if (caseError || !thisCase) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  // Root is either the parent (if this is a renewal) or the case itself
  const rootId = thisCase.parent_case_id ?? id;

  // Fetch root + all renewals in one query
  const { data, error } = await supabase
    .from("cases")
    .select(
      "id, case_number, status, purpose, is_renewal, parent_case_id, start_date, end_date, tenure_months, rate, security_deposit, created_at, renewal_due_at"
    )
    .or(`id.eq.${rootId},parent_case_id.eq.${rootId}`)
    .order("start_date", { ascending: true, nullsFirst: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data || [] });
}

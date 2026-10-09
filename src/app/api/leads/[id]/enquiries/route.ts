import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/leads/[id]/enquiries — every public-form submission this lead has made,
// newest first, each with its reference number and its own claim / resolve state.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("lead_enquiries")
    .select(
      "id, reference, source, is_re_enquiry, received_at, payload, claimed_by, claimed_at, resolved_at, resolution_outcome, " +
        "claimer:users!lead_enquiries_claimed_by_fkey(id, full_name), " +
        "resolver:users!lead_enquiries_resolved_by_fkey(id, full_name)"
    )
    .eq("lead_id", id)
    .order("received_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Only the ad-source summary leaves here — the full submitted form stays on the row.
  // The long select string defeats supabase-js's type parsing, so give the rows their shape.
  const typed = (data ?? []) as unknown as Array<{ payload?: unknown } & Record<string, unknown>>;
  const rows = typed.map(({ payload, ...rest }) => ({
    ...rest,
    attribution: (payload as { attribution?: unknown } | null)?.attribution ?? null,
  }));

  return NextResponse.json({ data: rows });
}

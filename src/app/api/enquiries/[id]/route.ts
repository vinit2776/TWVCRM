import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { enquiryMessages, type RawEnquiryRow } from "@/lib/enquiries";

// GET /api/enquiries/[id]
// One enquiry with what the customer submitted and what the lead already holds, for the
// contact-back form. Only the customer's own fields leave here, never triage notes or ad attribution.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!me) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (me.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("lead_enquiries")
    .select(
      "id, reference, lead_id, source, is_re_enquiry, payload, received_at, claimed_at, resolved_at, resolution_outcome, " +
        "claimer:users!lead_enquiries_claimed_by_fkey(full_name), " +
        "lead:leads!lead_enquiries_lead_id_fkey(first_name, last_name, mobile, email, company, workspace_type, seat_capacity, budget_per_seat, location_id)",
    )
    .eq("id", id)
    .single();
  if (error || !data) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });

  // The long select defeats supabase-js's type parsing, so give the row its shape.
  const row = data as unknown as {
    payload: RawEnquiryRow["payload"];
  } & Record<string, unknown>;
  const { payload, ...rest } = row;
  const p = payload ?? {};

  return NextResponse.json({
    data: {
      ...rest,
      payload: {
        name: p.name,
        mobile: p.mobile,
        company: p.company,
        workspace_type: p.workspace_type,
        seat_capacity: p.seat_capacity,
        budget_per_seat: p.budget_per_seat,
        preferred_location: p.preferred_location,
        start_date: p.start_date,
      },
      message: enquiryMessages(payload).at(-1)?.text ?? null,
    },
  });
}

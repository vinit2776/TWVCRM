import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createWaitlistEntrySchema, zodErrorResponse } from "@/lib/validations";

export const dynamic = "force-dynamic";

// GET — List waitlist entries
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const spaceId = searchParams.get("space_id");

  let query = supabase
    .from("booking_waitlist")
    .select("*, space:spaces!booking_waitlist_space_id_fkey(id, name), lead:leads!booking_waitlist_lead_id_fkey(id, first_name, last_name, company, email, phone)")
    .order("created_at", { ascending: true });

  if (status) query = query.eq("status", status);
  if (spaceId) query = query.eq("space_id", spaceId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

// POST — Add to waitlist
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const parsed = createWaitlistEntrySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const input = parsed.data;

  // Fetch space for location
  const { data: space } = await supabase
    .from("spaces")
    .select("id, location_id")
    .eq("id", input.space_id)
    .single();

  if (!space) return NextResponse.json({ error: "Space not found" }, { status: 404 });

  const { data: entry, error } = await supabase
    .from("booking_waitlist")
    .insert({
      space_id: input.space_id,
      location_id: space.location_id,
      booking_date: input.booking_date,
      start_time: input.start_time,
      end_time: input.end_time,
      customer_type: input.customer_type,
      contract_id: input.contract_id || null,
      lead_id: input.lead_id || null,
      guest_name: input.guest_name || null,
      guest_phone: input.guest_phone || null,
      booker_phone: input.booker_phone,
      notes: input.notes || null,
      created_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: entry }, { status: 201 });
}

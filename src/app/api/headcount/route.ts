import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET  — list headcount entries (with filters)
// POST — create a new headcount entry
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const from       = searchParams.get("from");   // ISO date string
  const to         = searchParams.get("to");     // ISO date string
  const limit      = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const page       = Math.max(parseInt(searchParams.get("page") || "1"), 1);
  const offset     = (page - 1) * limit;

  let query = supabase
    .from("space_headcounts")
    .select(
      `id, location_id, recorded_at, recorded_by,
       open_desk, private_cabin, meeting_room, conference_room,
       total_count, notes, created_at,
       location:locations!space_headcounts_location_id_fkey(id, name, code, capacity_config),
       recorder:users!space_headcounts_recorded_by_fkey(id, full_name)`,
      { count: "exact" }
    )
    .order("recorded_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (locationId) query = query.eq("location_id", locationId);
  if (from)       query = query.gte("recorded_at", from);
  if (to)         query = query.lte("recorded_at", to);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: {
      total: count ?? 0,
      page,
      limit,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve internal user id
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const {
    location_id,
    recorded_at,
    open_desk,
    private_cabin,
    meeting_room,
    conference_room,
    total_count,
    notes,
  } = body;

  if (!location_id) return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  if (total_count == null || total_count < 0) {
    return NextResponse.json({ error: "total_count must be a non-negative number" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("space_headcounts")
    .insert({
      location_id,
      recorded_at:    recorded_at || new Date().toISOString(),
      recorded_by:    dbUser.id,
      open_desk:       open_desk       != null ? Number(open_desk)       : null,
      private_cabin:   private_cabin   != null ? Number(private_cabin)   : null,
      meeting_room:    meeting_room    != null ? Number(meeting_room)    : null,
      conference_room: conference_room != null ? Number(conference_room) : null,
      total_count:     Number(total_count),
      notes:           notes?.trim() || null,
    })
    .select(
      `id, location_id, recorded_at, recorded_by,
       open_desk, private_cabin, meeting_room, conference_room,
       total_count, notes, created_at,
       location:locations!space_headcounts_location_id_fkey(id, name, code, capacity_config),
       recorder:users!space_headcounts_recorded_by_fkey(id, full_name)`
    )
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data }, { status: 201 });
}

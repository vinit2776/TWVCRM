import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createSpaceSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const locationId = searchParams.get("location_id");
  const isActive = searchParams.get("is_active");
  const search = searchParams.get("search");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("spaces")
    .select(
      "*, location:locations!spaces_location_id_fkey(id, name, code), facilities:space_facilities(*)",
      { count: "exact" }
    );

  if (locationId) query = query.eq("location_id", locationId);
  if (isActive !== null && isActive !== "") query = query.eq("is_active", isActive === "true");
  if (search?.trim()) query = query.ilike("name", `%${search.trim()}%`);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions to create spaces" }, { status: 403 });
  }

  const body = await request.json();
  const result = createSpaceSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { facilities, ...spaceData } = result.data;

  const { data: space, error } = await supabase
    .from("spaces")
    .insert({ ...spaceData, created_by: dbUser.id })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Insert facilities if provided
  if (facilities && facilities.length > 0 && space) {
    const facilityRows = facilities.map((f) => ({
      space_id: space.id,
      name: f.name,
      is_complimentary: f.is_complimentary,
      charge_per_use: f.charge_per_use,
    }));
    await supabase.from("space_facilities").insert(facilityRows);
  }

  // Fetch with facilities
  const { data: fullSpace } = await supabase
    .from("spaces")
    .select("*, location:locations!spaces_location_id_fkey(id, name, code), facilities:space_facilities(*)")
    .eq("id", space.id)
    .single();

  if (dbUser.id) {
    logAudit(supabase, {
      entityType: "space",
      entityId: space.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: space } },
    });
  }

  return NextResponse.json({ data: fullSpace }, { status: 201 });
}

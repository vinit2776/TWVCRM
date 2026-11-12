import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// In-charge user joins reused by GET (list) and POST (return).
// Two named FKs let PostgREST disambiguate which slot each user fills.
const LOCATION_SELECT = `
  *,
  companies(id, name, brand_name),
  incharge_1:users!locations_incharge_user_id_1_fkey(id, full_name, email, role),
  incharge_2:users!locations_incharge_user_id_2_fkey(id, full_name, email, role)
`;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isActive = request.nextUrl.searchParams.get("is_active");
  const companyId = request.nextUrl.searchParams.get("company_id");
  // Central hubs (HQ stock store) are hidden from every normal location
  // picker. Procurement contexts that genuinely need the hub (transfer
  // source, reorder settings, replenishment, MR/PO) opt in explicitly.
  const includeHubs = request.nextUrl.searchParams.get("include_hubs") === "true";
  const hubsOnly = request.nextUrl.searchParams.get("hubs_only") === "true";

  let query = supabase
    .from("locations")
    .select(LOCATION_SELECT)
    .order("name", { ascending: true });

  if (isActive === "true") {
    query = query.eq("is_active", true);
  } else if (isActive === "false") {
    query = query.eq("is_active", false);
  }

  if (companyId) {
    query = query.eq("company_id", companyId);
  }

  if (hubsOnly) {
    query = query.eq("is_hub", true);
  } else if (!includeHubs) {
    query = query.eq("is_hub", false);
  }

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check admin role
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const {
    name, code, company_id, address, city, state, capacity_config, requires_headcount,
    latitude, longitude, incharge_user_id_1, incharge_user_id_2,
  } = body as {
    name: string;
    code: string;
    company_id: string;
    address?: string;
    city?: string;
    state?: string;
    capacity_config?: Record<string, number>;
    requires_headcount?: boolean;
    latitude?: number | null;
    longitude?: number | null;
    incharge_user_id_1?: string | null;
    incharge_user_id_2?: string | null;
  };

  if (!name || !code) {
    return NextResponse.json({ error: "Name and code are required" }, { status: 400 });
  }
  if (!company_id) {
    return NextResponse.json({ error: "Company is required" }, { status: 400 });
  }

  // The DB CHECK constraint already prevents the same user in both slots,
  // but we surface a friendlier error before the round-trip.
  if (
    incharge_user_id_1 &&
    incharge_user_id_2 &&
    incharge_user_id_1 === incharge_user_id_2
  ) {
    return NextResponse.json(
      { error: "The two floor in-charges must be different users" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("locations")
    .insert({
      name,
      code: code.toUpperCase(),
      company_id,
      address: address || null,
      city: city || null,
      state: state || null,
      capacity_config: capacity_config || {},
      requires_headcount: requires_headcount ?? false,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      incharge_user_id_1: incharge_user_id_1 || null,
      incharge_user_id_2: incharge_user_id_2 || null,
    })
    .select(LOCATION_SELECT)
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Location code already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "location",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      name: { old: null, new: name },
      code: { old: null, new: code },
      incharge_user_id_1: { old: null, new: incharge_user_id_1 ?? null },
      incharge_user_id_2: { old: null, new: incharge_user_id_2 ?? null },
    },
  });

  return NextResponse.json({ data }, { status: 201 });
}

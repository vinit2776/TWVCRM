import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("locations")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    name, code, address, city, state, is_active, capacity_config, requires_headcount,
    latitude, longitude, incharge_user_id_1, incharge_user_id_2,
    unifi_site_id, unifi_console_id, wifi_voucher_mode, proposal_amenity_icons,
  } = body as {
    name?: string;
    code?: string;
    address?: string;
    city?: string;
    state?: string;
    is_active?: boolean;
    capacity_config?: Record<string, number>;
    requires_headcount?: boolean;
    latitude?: number | null;
    longitude?: number | null;
    incharge_user_id_1?: string | null;
    incharge_user_id_2?: string | null;
    unifi_site_id?: string | null;
    unifi_console_id?: string | null;
    wifi_voucher_mode?: string | null;
    proposal_amenity_icons?: string[];
  };

  // Same-user-twice guard mirrors the POST route + DB constraint so we
  // surface a friendlier error before the round-trip.
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

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (code !== undefined) updates.code = code.toUpperCase();
  if (address !== undefined) updates.address = address;
  if (city !== undefined) updates.city = city;
  if (state !== undefined) updates.state = state;
  if (is_active !== undefined) updates.is_active = is_active;
  if (capacity_config !== undefined) updates.capacity_config = capacity_config;
  if (requires_headcount !== undefined) updates.requires_headcount = requires_headcount;
  if (latitude !== undefined) updates.latitude = latitude;
  if (longitude !== undefined) updates.longitude = longitude;
  if (incharge_user_id_1 !== undefined) updates.incharge_user_id_1 = incharge_user_id_1 || null;
  if (incharge_user_id_2 !== undefined) updates.incharge_user_id_2 = incharge_user_id_2 || null;
  if (unifi_site_id !== undefined) updates.unifi_site_id = unifi_site_id || null;
  if (unifi_console_id !== undefined) updates.unifi_console_id = unifi_console_id || null;
  if (wifi_voucher_mode !== undefined) updates.wifi_voucher_mode = wifi_voucher_mode || null;
  if (proposal_amenity_icons !== undefined) updates.proposal_amenity_icons = proposal_amenity_icons;

  const { data, error } = await supabase
    .from("locations")
    .update(updates)
    .eq("id", id)
    .select(`
      *,
      incharge_1:users!locations_incharge_user_id_1_fkey(id, full_name, email, role),
      incharge_2:users!locations_incharge_user_id_2_fkey(id, full_name, email, role)
    `)
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Location code already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, { entityType: "location", entityId: id, action: "update", performedBy: dbUser.id, changes: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { old: null, new: v }])) });

  return NextResponse.json({ data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Soft-delete: set is_active = false
  const { data, error } = await supabase
    .from("locations")
    .update({ is_active: false })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, { entityType: "location", entityId: id, action: "delete", performedBy: dbUser.id, changes: { is_active: { old: true, new: false } } });

  return NextResponse.json({ data });
}

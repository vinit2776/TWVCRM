import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { agreementTermsSchema, canEditAgreementTerms, cleanAgreementTerms } from "@/lib/agreement-terms";

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

  if (!dbUser || !["admin", "manager", "it_manager", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin, Manager or IT Manager access required" }, { status: 403 });
  }

  const body = await request.json();

  // A sales rep may set the location's agreement wording and nothing else.
  const agreementTermsOnly = dbUser.role === "sales_rep";
  if (agreementTermsOnly && Object.keys(body).some((k) => k !== "agreement_terms")) {
    return NextResponse.json({ error: "Admin, Manager or IT Manager access required" }, { status: 403 });
  }
  const {
    name, code, address, city, state, is_active, capacity_config, requires_headcount,
    latitude, longitude, incharge_user_id_1, incharge_user_id_2,
    unifi_site_id, unifi_console_id, wifi_voucher_mode, wifi_ssid, proposal_amenity_icons, agreement_terms,
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
    wifi_ssid?: string | null;
    proposal_amenity_icons?: string[];
    agreement_terms?: unknown;
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

  // Live-API mode needs the location's own console — there is no default
  // console to fall back on, so refuse a save that would leave it without one.
  if (wifi_voucher_mode === "unifi_api" || (wifi_voucher_mode === undefined && unifi_console_id !== undefined)) {
    let effectiveMode = wifi_voucher_mode;
    let effectiveConsole = unifi_console_id;
    if (effectiveMode === undefined || effectiveConsole === undefined) {
      const { data: current } = await supabase
        .from("locations").select("wifi_voucher_mode, unifi_console_id").eq("id", id).maybeSingle();
      if (effectiveMode === undefined) effectiveMode = current?.wifi_voucher_mode;
      if (effectiveConsole === undefined) effectiveConsole = current?.unifi_console_id;
    }
    if (effectiveMode === "unifi_api" && !effectiveConsole?.trim()) {
      return NextResponse.json(
        { error: "A UniFi Console ID is required for Live API mode — there is no default console." },
        { status: 400 }
      );
    }
  }

  // Network name printed in voucher emails: blank puts the location back on the standard name.
  if (wifi_ssid !== undefined && wifi_ssid !== null && (typeof wifi_ssid !== "string" || wifi_ssid.trim().length > 32)) {
    return NextResponse.json({ error: "WiFi network name must be 32 characters or fewer" }, { status: 400 });
  }

  // Agreement wording is legal text: admin, manager and sales rep only (the route also admits it_manager).
  // null puts the location back on the standard wording.
  let cleanedTerms: unknown;
  if (agreement_terms !== undefined) {
    if (!canEditAgreementTerms(dbUser.role)) {
      return NextResponse.json({ error: "Only an admin, manager or sales rep can change agreement terms" }, { status: 403 });
    }
    if (agreement_terms === null) {
      cleanedTerms = null;
    } else {
      const parsed = agreementTermsSchema.safeParse(agreement_terms);
      if (!parsed.success) {
        return NextResponse.json({ error: "Agreement terms are invalid: keep each line under 300 characters and at most 12 lines per list" }, { status: 400 });
      }
      cleanedTerms = cleanAgreementTerms(parsed.data);
    }
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
  if (wifi_ssid !== undefined) updates.wifi_ssid = wifi_ssid?.trim() || null;
  if (proposal_amenity_icons !== undefined) updates.proposal_amenity_icons = proposal_amenity_icons;
  if (agreement_terms !== undefined) updates.agreement_terms = cleanedTerms;

  // The locations update policy is admin/manager/IT manager only, so the sales-rep path
  // writes with the service client — safe because the body was limited to agreement_terms above.
  const writer = agreementTermsOnly ? createAdminClient() : supabase;
  const { data, error } = await writer
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

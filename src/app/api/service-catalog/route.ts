import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * GET /api/service-catalog
 * Lists active services. Use `?include_inactive=true` to include retired ones.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const includeInactive = request.nextUrl.searchParams.get("include_inactive") === "true";

  let query = supabase
    .from("service_catalog")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (!includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

/**
 * POST /api/service-catalog (admin/manager)
 * Body: { slug, name, unit_label, default_overage_rate, gst_rate?, printer_column?, sort_order? }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const {
    slug, name, description, unit_label,
    default_overage_rate, gst_rate = 18,
    printer_column, sort_order = 0,
  } = body;

  if (!slug || !name || !unit_label) {
    return NextResponse.json({ error: "slug, name and unit_label are required" }, { status: 400 });
  }
  if (default_overage_rate == null || isNaN(Number(default_overage_rate)) || Number(default_overage_rate) < 0) {
    return NextResponse.json({ error: "default_overage_rate must be a non-negative number" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("service_catalog")
    .insert({
      slug: String(slug).trim().toLowerCase(),
      name: String(name).trim(),
      description: description || null,
      unit_label: String(unit_label).trim(),
      default_overage_rate: Number(default_overage_rate),
      gst_rate: Number(gst_rate),
      printer_column: printer_column || null,
      sort_order: Number(sort_order),
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "Slug already exists" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "service_catalog", entityId: data.id, action: "create",
    performedBy: dbUser.id, changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

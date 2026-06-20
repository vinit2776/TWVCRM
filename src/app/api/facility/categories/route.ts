import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope");
  const includeInactive = searchParams.get("include_inactive") === "true";

  let query = supabase
    .from("facility_asset_categories")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (scope) query = query.eq("scope", scope);
  if (!includeInactive) query = query.eq("is_active", true);
  // Only return the 6 canonical group categories unless caller opts out
  const includeAll = searchParams.get("include_all") === "true";
  if (!includeAll) query = query.like("slug", "group-%");

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.manage)) {
    return NextResponse.json({ error: "Admin or IT Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const {
    scope, name, slug, icon, description,
    default_sla_critical_hrs = 2, default_sla_high_hrs = 8,
    default_sla_medium_hrs = 24, default_sla_low_hrs = 72,
    sort_order = 0,
  } = body;

  if (!scope || !name || !slug) {
    return NextResponse.json({ error: "scope, name and slug are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("facility_asset_categories")
    .insert({
      scope, name: String(name).trim(), slug: String(slug).trim().toLowerCase(),
      icon: icon || null, description: description || null,
      default_sla_critical_hrs: Number(default_sla_critical_hrs),
      default_sla_high_hrs: Number(default_sla_high_hrs),
      default_sla_medium_hrs: Number(default_sla_medium_hrs),
      default_sla_low_hrs: Number(default_sla_low_hrs),
      sort_order: Number(sort_order),
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "Slug already exists" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "facility_asset_category",
    entityId: data.id,
    action: "create",
    performedBy: dbUser!.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

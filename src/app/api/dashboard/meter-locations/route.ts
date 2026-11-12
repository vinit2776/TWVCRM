import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { asString, fetchByIds } from "@/lib/dashboard-query";

/**
 * GET /api/dashboard/meter-locations
 * The locations that have live meter telemetry (OneGrid) switched on, for the
 * dashboard widget's location picker. Returns only id, name and the saved
 * default meter — never the API key.
 *
 * Read-only. Access: admin, manager, fms.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "fms"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: configs, error } = await admin
    .from("location_electricity_config")
    .select("location_id, onegrid_default_device_id, onegrid_api_key")
    .eq("onegrid_enabled", true);
  if (error) {
    console.error("[dashboard/meter-locations]", error.message);
    return NextResponse.json({ error: "Failed to load meter locations" }, { status: 500 });
  }

  // A location is only usable if it actually holds a key — same test the
  // telemetry routes apply.
  const usable = (configs ?? []).filter((c) => Boolean(c.onegrid_api_key));
  const locations = await fetchByIds(admin, "locations", "id, name, is_active", usable.map((c) => c.location_id as string));
  const nameById = new Map(locations.filter((l) => l.is_active !== false).map((l) => [l.id as string, asString(l.name) ?? "Location"]));

  const data = usable
    .filter((c) => nameById.has(c.location_id as string))
    .map((c) => ({
      id: c.location_id as string,
      name: nameById.get(c.location_id as string)!,
      default_device_id: asString(c.onegrid_default_device_id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ data });
}

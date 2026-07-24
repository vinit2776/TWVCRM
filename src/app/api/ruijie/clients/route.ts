/**
 * GET /api/ruijie/clients?location_id=<uuid>
 *
 * Currently-connected clients for the given Ruijie-managed location — signal
 * quality, throughput, session duration. Requires admin | manager |
 * sales_rep | floor_manager | office_admin | it_manager role.
 *
 * Response: { data: RuijieClient[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { listRuijieClients } from "@/lib/ruijie";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const allowed = ["admin", "manager", "sales_rep", "floor_manager", "office_admin", "it_manager"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  if (!locationId) {
    return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: location } = await admin
    .from("locations")
    .select("id, name, ruijie_group_id")
    .eq("id", locationId)
    .single();

  if (!location?.ruijie_group_id) {
    return NextResponse.json({ error: "This location is not managed via the Ruijie API" }, { status: 400 });
  }

  try {
    const clients = await listRuijieClients(location.ruijie_group_id);
    clients.sort((a, b) => b.onlineTime - a.onlineTime);
    return NextResponse.json({ data: clients, location });
  } catch (err) {
    console.error("[api/ruijie/clients] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach Ruijie Cloud" },
      { status: 502 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { eventId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const allowed = ["admin", "manager", "fms"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin/manager/fms can confirm visits" }, { status: 403 });
  }

  const admin = createAdminClient();

  const { data: event } = await admin
    .from("amc_service_events")
    .select("id, confirmed_at")
    .eq("id", eventId)
    .single();

  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  if (event.confirmed_at) return NextResponse.json({ error: "Already confirmed" }, { status: 409 });

  const { error } = await admin
    .from("amc_service_events")
    .update({
      confirmed_by: dbUser.id,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", eventId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

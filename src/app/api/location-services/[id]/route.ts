import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// PATCH — update a service
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin and managers can manage services" }, { status: 403 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.unit !== undefined) updates.unit = body.unit.trim();
  if (body.price_per_unit !== undefined) updates.price_per_unit = Number(body.price_per_unit);
  if (body.is_active !== undefined) updates.is_active = Boolean(body.is_active);

  const { data, error } = await supabase
    .from("location_services")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

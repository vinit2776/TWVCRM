import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — fetch a single package template
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data, error } = await supabase
    .from("prepaid_packages")
    .select("*, location:locations(id,name)")
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Package not found" }, { status: 404 });

  return NextResponse.json({ data });
}

// PATCH — update a package template
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.price !== undefined) updates.price = Number(body.price);
  if (body.validity_days !== undefined) updates.validity_days = Number(body.validity_days);
  if (body.is_active !== undefined) updates.is_active = Boolean(body.is_active);
  if (body.workspace_type !== undefined) updates.workspace_type = body.workspace_type || null;
  if (body.location_id !== undefined) updates.location_id = body.location_id || null;

  const { data, error } = await supabase
    .from("prepaid_packages")
    .update(updates)
    .eq("id", id)
    .select("*, location:locations(id,name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// PATCH /api/proposal-presets/[id]
// Update any field on a preset
// ---------------------------------------------------------------------------
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const allowed: Record<string, unknown> = {};

  if (body.name !== undefined)        allowed.name        = String(body.name).trim();
  if (body.description !== undefined) allowed.description = String(body.description).trim();
  if (body.quantity !== undefined)    allowed.quantity    = Number(body.quantity) || 1;
  if (body.unit !== undefined)        allowed.unit        = body.unit?.trim() || null;
  if (body.unit_price !== undefined)  allowed.unit_price  = Number(body.unit_price);
  if (body.category !== undefined)    allowed.category    = body.category?.trim() || null;
  if (body.sort_order !== undefined)  allowed.sort_order  = Number(body.sort_order) || 0;
  if (body.is_active !== undefined)   allowed.is_active   = Boolean(body.is_active);

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("proposal_line_item_presets")
    .update(allowed)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Preset not found" }, { status: 404 });

  return NextResponse.json({ data });
}

// ---------------------------------------------------------------------------
// DELETE /api/proposal-presets/[id]
// Hard delete — presets are not referenced by FK anywhere
// ---------------------------------------------------------------------------
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("proposal_line_item_presets")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}

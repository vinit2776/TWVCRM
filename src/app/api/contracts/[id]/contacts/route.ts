import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * GET /api/contracts/[id]/contacts
 * List all contacts for a contract.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_contacts")
    .select("*")
    .eq("contract_id", id)
    .order("contact_role", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

/**
 * POST /api/contracts/[id]/contacts
 * Add a new contact to a contract.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();

  const body = await request.json();

  if (!body.full_name?.trim()) {
    return NextResponse.json({ error: "Full name is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("contract_contacts")
    .insert({
      contract_id: id,
      full_name: body.full_name.trim(),
      designation: body.designation?.trim() || null,
      email: body.email?.trim() || null,
      phone: body.phone?.trim() || null,
      mobile: body.mobile?.trim() || null,
      contact_role: body.contact_role || "general",
      notes: body.notes?.trim() || null,
      is_active: body.is_active !== false,
      created_by: dbUser?.id || null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { contact_added: { old: null, new: data.full_name } },
    });
  }

  return NextResponse.json({ data }, { status: 201 });
}

/**
 * PATCH /api/contracts/[id]/contacts
 * Update an existing contact. Body must include `contact_id`.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  if (!body.contact_id) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.full_name !== undefined) updates.full_name = body.full_name?.trim() || null;
  if (body.designation !== undefined) updates.designation = body.designation?.trim() || null;
  if (body.email !== undefined) updates.email = body.email?.trim() || null;
  if (body.phone !== undefined) updates.phone = body.phone?.trim() || null;
  if (body.mobile !== undefined) updates.mobile = body.mobile?.trim() || null;
  if (body.contact_role !== undefined) updates.contact_role = body.contact_role;
  if (body.notes !== undefined) updates.notes = body.notes?.trim() || null;
  if (body.is_active !== undefined) updates.is_active = body.is_active;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("contract_contacts")
    .update(updates)
    .eq("id", body.contact_id)
    .eq("contract_id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

/**
 * DELETE /api/contracts/[id]/contacts
 * Remove a contact. Body must include `contact_id`.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  if (!body.contact_id) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("contract_contacts")
    .delete()
    .eq("id", body.contact_id)
    .eq("contract_id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { contact_removed: { old: body.contact_id, new: null } },
    });
  }

  return NextResponse.json({ message: "Contact removed" });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  const body = await request.json();

  const allowedFields = ["name", "unit", "cost_per_unit", "free_quota", "is_active"];
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("contract_facilities")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (updated && dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract_facility",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { updates: { old: null, new: updates } },
    });
  }

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  // Check if any usage records exist for this facility
  const { count } = await supabase
    .from("facility_usage_records")
    .select("id", { count: "exact", head: true })
    .eq("contract_facility_id", id);

  if (count && count > 0) {
    // Soft-delete: set is_active to false
    const { data: updated, error } = await supabase
      .from("contract_facilities")
      .update({ is_active: false })
      .eq("id", id)
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (dbUser?.id) {
      logAudit(supabase, {
        entityType: "contract_facility",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: { is_active: { old: true, new: false } },
      });
    }

    return NextResponse.json({ data: updated, message: "Facility deactivated (has usage records)" });
  }

  // Hard delete if no usage records
  const { error } = await supabase
    .from("contract_facilities")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract_facility",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
    });
  }

  return NextResponse.json({ message: "Facility deleted" });
}

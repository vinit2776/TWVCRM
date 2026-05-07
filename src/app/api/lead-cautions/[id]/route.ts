/**
 * PATCH /api/lead-cautions/[id]
 *
 * Soft-dismiss (is_active=false) or edit a caution. The caution stays
 * in the database for audit; just doesn't surface on the UI banners
 * anymore.
 *
 * Authorisation:
 *   - Admin / manager: any caution
 *   - Floor manager: cautions they created
 *   - Anyone else: blocked
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const { data: caution } = await supabase
    .from("lead_cautions").select("*").eq("id", id).single();
  if (!caution) return NextResponse.json({ error: "Caution not found" }, { status: 404 });

  const isAdminOrManager = ["admin", "manager"].includes(dbUser.role);
  const isCreator = caution.created_by === dbUser.id;
  const isFloorManager = dbUser.role === "floor_manager";

  if (!isAdminOrManager && !(isFloorManager && isCreator)) {
    return NextResponse.json(
      { error: "Only admin / manager / the floor manager who created it can modify this caution" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (body.is_active !== undefined) {
    updates.is_active = !!body.is_active;
    if (!body.is_active) {
      updates.dismissed_by = dbUser.id;
      updates.dismissed_at = new Date().toISOString();
    } else {
      updates.dismissed_by = null;
      updates.dismissed_at = null;
    }
  }
  if (body.note !== undefined) updates.note = String(body.note).trim();
  if (body.severity !== undefined) {
    if (!["info", "warning", "danger"].includes(body.severity)) {
      return NextResponse.json({ error: "Invalid severity" }, { status: 400 });
    }
    updates.severity = body.severity;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("lead_cautions")
    .update(updates)
    .eq("id", id)
    .select(`
      *,
      creator:users!lead_cautions_created_by_fkey(id, full_name),
      booking:bookings!lead_cautions_booking_id_fkey(id, booking_number)
    `)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "lead_caution",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(caution as Record<string, unknown>, updates),
  });

  return NextResponse.json({ data });
}

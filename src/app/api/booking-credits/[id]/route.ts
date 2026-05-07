/**
 * PATCH /api/booking-credits/[id]
 *
 * Floor manager+ overrides:
 *   - extend or shorten expires_at
 *   - revoke the credit (status → revoked)
 *   - edit the note
 *
 * Hours_total / hours_used are intentionally not editable — those are
 * set at issue time and consumed by booking-creation. Adjusting them
 * by hand would let staff silently mint or destroy hours, which is
 * exactly what we don't want.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

const STAFF_ROLES = new Set(["admin", "manager", "floor_manager"]);

const CREDIT_SELECT = `
  *,
  location:locations!booking_credits_location_id_fkey(id, name, code),
  lead:leads!booking_credits_lead_id_fkey(id, first_name, last_name, company),
  issued_from_booking:bookings!booking_credits_issued_from_booking_id_fkey(id, booking_number)
`;

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
  if (!dbUser || !STAFF_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Floor manager / manager / admin access required" },
      { status: 403 }
    );
  }

  const { data: oldCredit } = await supabase
    .from("booking_credits").select("*").eq("id", id).single();
  if (!oldCredit) return NextResponse.json({ error: "Credit not found" }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (body.expires_at !== undefined) {
    const exp = new Date(body.expires_at);
    if (isNaN(exp.getTime())) {
      return NextResponse.json({ error: "expires_at must be a valid date" }, { status: 400 });
    }
    updates.expires_at = exp.toISOString();
  }

  if (body.notes !== undefined) updates.notes = body.notes || null;

  if (body.status !== undefined) {
    if (body.status !== "revoked" && body.status !== "active") {
      return NextResponse.json(
        { error: "Only 'active' or 'revoked' status changes are allowed" },
        { status: 400 }
      );
    }
    updates.status = body.status;
    if (body.status === "revoked") {
      updates.revoked_by = dbUser.id;
      updates.revoked_at = new Date().toISOString();
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data: credit, error } = await supabase
    .from("booking_credits")
    .update(updates)
    .eq("id", id)
    .select(CREDIT_SELECT)
    .single();

  if (error || !credit) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "booking_credit",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(oldCredit as Record<string, unknown>, updates),
  });

  return NextResponse.json({ data: credit });
}

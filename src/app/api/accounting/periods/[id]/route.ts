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

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await request.json();
  const { action, notes } = body as { action: "lock" | "unlock"; notes?: string };

  if (!["lock", "unlock"].includes(action)) {
    return NextResponse.json({ error: "Invalid action. Use 'lock' or 'unlock'" }, { status: 400 });
  }

  // Fetch current period
  const { data: period, error: fetchError } = await supabase
    .from("accounting_periods")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !period) {
    return NextResponse.json({ error: "Accounting period not found" }, { status: 404 });
  }

  if (action === "lock") {
    // Requires floor_manager or admin role
    if (!["admin", "manager", "floor_manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only floor managers, managers, or admins can lock periods" }, { status: 403 });
    }
    if (period.status === "locked") {
      return NextResponse.json({ error: "Period is already locked" }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabase
      .from("accounting_periods")
      .update({
        status: "locked",
        locked_at: new Date().toISOString(),
        locked_by: dbUser.id,
        notes: notes || period.notes,
      })
      .eq("id", id)
      .select("*, locker:users!accounting_periods_locked_by_fkey(id, full_name)")
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "accounting_period",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "open", new: "locked" } },
    });

    return NextResponse.json({ data: updated });
  }

  if (action === "unlock") {
    // Requires admin role only
    if (dbUser.role !== "admin") {
      return NextResponse.json({ error: "Only admins can unlock periods" }, { status: 403 });
    }
    if (period.status === "open") {
      return NextResponse.json({ error: "Period is already open" }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabase
      .from("accounting_periods")
      .update({
        status: "open",
        unlocked_at: new Date().toISOString(),
        unlocked_by: dbUser.id,
        notes: notes || period.notes,
      })
      .eq("id", id)
      .select("*, locker:users!accounting_periods_locked_by_fkey(id, full_name)")
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "accounting_period",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "locked", new: "open" } },
    });

    return NextResponse.json({ data: updated });
  }
}

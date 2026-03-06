import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * PATCH /api/vouchers/reclassify
 * Bulk-assigns a validity_days value to all vouchers where validity_days is NULL.
 * Admin only.
 *
 * Body: { validity_days: number; location_id?: string }
 * Returns: { updated: number }
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Admin-only gate
  const { data: currentUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can reclassify vouchers" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const { validity_days, location_id } = body as {
    validity_days: number;
    location_id?: string;
  };

  if (validity_days == null || typeof validity_days !== "number") {
    return NextResponse.json(
      { error: "validity_days is required and must be a number" },
      { status: 400 }
    );
  }

  // Build update query: only target available vouchers with no validity set
  let query = supabase
    .from("voucher_repository")
    .update({ validity_days })
    .is("validity_days", null)
    .eq("status", "available");

  if (location_id) {
    query = query.eq("location_id", location_id);
  }

  const { data, error } = await query.select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const updated = data?.length ?? 0;

  // Single audit entry recording the bulk operation
  if (updated > 0) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: "bulk",
      action: "update",
      performedBy: currentUser.id,
      changes: {
        validity_days: { old: null, new: validity_days },
        affected_count: { old: 0, new: updated },
        location_id: { old: null, new: location_id ?? "all" },
      },
    });
  }

  return NextResponse.json({ updated });
}

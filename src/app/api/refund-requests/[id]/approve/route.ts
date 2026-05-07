/**
 * PATCH /api/refund-requests/[id]/approve
 *
 * Manager / admin moves a refund request from pending_approval →
 * approved. After this, finance can pick it up to process the actual
 * refund. Idempotent: re-approving an already-approved request is a
 * no-op rather than an error so a stale browser tab doesn't surface
 * a confusing failure.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Manager / admin access required to approve refunds" },
      { status: 403 }
    );
  }

  const { data: rr } = await supabase
    .from("refund_requests").select("*").eq("id", id).single();
  if (!rr) return NextResponse.json({ error: "Refund request not found" }, { status: 404 });

  if (rr.status === "approved") return NextResponse.json({ data: rr });
  if (rr.status !== "pending_approval") {
    return NextResponse.json(
      { error: `Cannot approve a ${rr.status} request` },
      { status: 400 }
    );
  }

  const { data: updated, error } = await supabase
    .from("refund_requests")
    .update({
      status: "approved",
      approved_by: dbUser.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "refund_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: rr.status, new: "approved" },
      approved_by: { old: null, new: dbUser.id },
    },
  });

  return NextResponse.json({ data: updated });
}

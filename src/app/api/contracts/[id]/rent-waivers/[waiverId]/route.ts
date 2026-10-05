import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// DELETE /api/contracts/[id]/rent-waivers/[waiverId] — undo a waiver (admin only).
// Soft: sets revoked_at so the month reappears as a gap and the history stays.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; waiverId: string }> }
) {
  const { id: contractId, waiverId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can undo a waiver" }, { status: 403 });
  }

  const { data: waiver, error } = await admin
    .from("contract_rent_waivers")
    .update({ revoked_at: new Date().toISOString(), revoked_by: dbUser.id })
    .eq("id", waiverId)
    .eq("contract_id", contractId)
    .is("revoked_at", null)
    .select("id, waived_month")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!waiver) return NextResponse.json({ error: "Waiver not found or already undone" }, { status: 404 });

  logAudit(admin, {
    entityType: "contract",
    entityId: contractId,
    action: "rent_month_waiver_revoked",
    performedBy: dbUser.id,
    changes: { waived_month: { old: waiver.waived_month, new: null } },
  });

  return NextResponse.json({ ok: true });
}

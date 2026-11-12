/**
 * DELETE /api/analytics/centers/projections/adjustments/[id]
 * Admin-only. Removes a manual projection adjustment.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const, dbUser: null };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return { error: "Admin access required", status: 403 as const, dbUser: null };
  }
  return { error: null, status: 200 as const, dbUser };
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error || !auth.dbUser) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: existing, error: fetchErr } = await supabase
    .from("projection_adjustments").select("id, contract_id, month, amount, reason").eq("id", id).single();
  if (fetchErr || !existing) {
    return NextResponse.json({ error: "Adjustment not found" }, { status: 404 });
  }

  const { error: deleteErr } = await supabase.from("projection_adjustments").delete().eq("id", id);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: existing.contract_id,
    action: "projection_adjustment_removed",
    performedBy: auth.dbUser.id,
    changes: {
      month: { old: existing.month, new: null },
      amount: { old: existing.amount, new: null },
      reason: { old: existing.reason, new: null },
    },
  });

  return NextResponse.json({ data: { success: true } });
}

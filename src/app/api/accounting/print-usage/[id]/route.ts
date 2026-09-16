import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * PATCH /api/accounting/print-usage/[id]
 *
 * Waives a single service_usage_records row (print/service overage) — the
 * only mutation this endpoint supports. Print usage previously had no way
 * to leave the Unbilled queue except through the ordinary monthly billing
 * sweep; a row whose covering statement already went out ("supplemental
 * needed") is never revisited by that sweep and had no other exit. See
 * 00559_service_facility_charge_waive.sql.
 *
 * Body: { waive: true, waive_reason: string }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: record, error: fetchError } = await supabase
    .from("service_usage_records")
    .select("id, is_billed, waived_at, overage_quantity, amount")
    .eq("id", id)
    .single();
  if (fetchError || !record) return NextResponse.json({ error: "Usage record not found" }, { status: 404 });
  if (record.is_billed) return NextResponse.json({ error: "Already billed — cannot be waived" }, { status: 400 });
  if (record.waived_at) return NextResponse.json({ error: "Already waived" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  if (body.waive !== true) return NextResponse.json({ error: "No valid fields" }, { status: 400 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin and managers can waive charges" }, { status: 403 });
  }

  const waiveReason = (body.waive_reason as string | undefined)?.trim();
  if (!waiveReason) return NextResponse.json({ error: "A reason is required when waiving a charge" }, { status: 400 });

  const { data: updated, error: updateError } = await supabase
    .from("service_usage_records")
    .update({ waived_at: new Date().toISOString(), waived_by: dbUser.id, waive_reason: waiveReason })
    .eq("id", id)
    .select()
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "service_usage_record",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { waived_at: { old: null, new: updated.waived_at }, waive_reason: { old: null, new: waiveReason } },
  });

  return NextResponse.json({ data: updated });
}

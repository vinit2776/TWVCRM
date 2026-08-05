import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { PAYMENT_BATCH_TYPES } from "@/lib/constants";

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({
    action: z.literal("update"),
    tolerance_percent: z.number().min(0).max(100).optional(),
    max_auto_approve_amount: z.number().positive().optional(),
    default_batch_type: z.enum(PAYMENT_BATCH_TYPES).optional(),
    notes: z.string().max(1000).nullish(),
  }),
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  const { id: vendorId, ruleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can change a recurring bill rule" }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { data: rule } = await supabase
    .from("procurement_recurring_bill_rules")
    .select("id, vendor_id, status")
    .eq("id", ruleId)
    .single();
  if (!rule || rule.vendor_id !== vendorId) {
    return NextResponse.json({ error: "Rule not found for this vendor" }, { status: 404 });
  }

  let updatePayload: Record<string, unknown> = {};
  let auditChanges: Record<string, { old: unknown; new: unknown }> = {};

  if (parsed.data.action === "pause") {
    if (rule.status === "paused") return NextResponse.json({ error: "Rule is already paused" }, { status: 422 });
    updatePayload = { status: "paused" };
    auditChanges = { status: { old: rule.status, new: "paused" } };
  } else if (parsed.data.action === "resume") {
    if (rule.status === "active") return NextResponse.json({ error: "Rule is already active" }, { status: 422 });
    const { data: existingActive } = await supabase
      .from("procurement_recurring_bill_rules")
      .select("id")
      .eq("vendor_id", vendorId)
      .eq("status", "active")
      .neq("id", ruleId)
      .maybeSingle();
    if (existingActive) {
      return NextResponse.json({ error: "This vendor already has a different active rule" }, { status: 409 });
    }
    updatePayload = { status: "active" };
    auditChanges = { status: { old: rule.status, new: "active" } };
  } else {
    const { tolerance_percent, max_auto_approve_amount, default_batch_type, notes } = parsed.data;
    updatePayload = {
      ...(tolerance_percent !== undefined ? { tolerance_percent } : {}),
      ...(max_auto_approve_amount !== undefined ? { max_auto_approve_amount } : {}),
      ...(default_batch_type !== undefined ? { default_batch_type } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }
    auditChanges = Object.fromEntries(
      Object.entries(updatePayload).map(([k, v]) => [k, { old: null, new: v }])
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from("procurement_recurring_bill_rules")
    .update(updatePayload)
    .eq("id", ruleId)
    .select("*")
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "recurring_bill_rule",
    entityId: ruleId,
    action: parsed.data.action === "pause" ? "disable" : parsed.data.action === "resume" ? "enable" : "update",
    performedBy: dbUser.id,
    changes: auditChanges,
  });

  return NextResponse.json({ data: updated });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

const OVERRIDE_ROLES = ["admin", "manager", "office_admin"];

const patchSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  location_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  cadence_type: z.enum(["daily", "weekly", "monthly"]).optional(),
  day_of_week: z.number().int().min(0).max(6).nullable().optional(),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  skip_if_open: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

/**
 * PATCH /api/facility/recurrence-rules/[id]
 * Edit a rule or toggle is_active (pause/resume). Restricted to the rule's
 * creator or admin/manager/office_admin — enforced here for a clear error
 * message, and backstopped by RLS's UPDATE policy either way.
 */
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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: existing, error: loadErr } = await supabase
    .from("task_recurrence_rules").select("*").eq("id", id).single();
  if (loadErr || !existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = existing.created_by === dbUser.id;
  const isOverride = OVERRIDE_ROLES.includes(dbUser.role);
  if (!isOwner && !isOverride) {
    return NextResponse.json({ error: "Only the rule's creator or an admin/manager can edit it" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const updates: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  const cadence = parsed.data.cadence_type ?? existing.cadence_type;
  if (cadence === "daily") {
    updates.day_of_week = null;
    updates.day_of_month = null;
  } else if (cadence === "weekly") {
    updates.day_of_month = null;
  } else if (cadence === "monthly") {
    updates.day_of_week = null;
  }

  const { data, error } = await supabase
    .from("task_recurrence_rules").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "task_recurrence_rule", entityId: id, action: "update",
    performedBy: dbUser.id, changes: diffChanges(existing, data),
  });

  return NextResponse.json({ data });
}

/**
 * DELETE /api/facility/recurrence-rules/[id]
 * Same authorization as PATCH. Deleting a rule does not affect any
 * facility_issues already spawned from it (recurrence_rule_id → SET NULL).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: existing, error: loadErr } = await supabase
    .from("task_recurrence_rules").select("id, created_by, title").eq("id", id).single();
  if (loadErr || !existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = existing.created_by === dbUser.id;
  const isOverride = OVERRIDE_ROLES.includes(dbUser.role);
  if (!isOwner && !isOverride) {
    return NextResponse.json({ error: "Only the rule's creator or an admin/manager can delete it" }, { status: 403 });
  }

  const { error } = await supabase.from("task_recurrence_rules").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "task_recurrence_rule", entityId: id, action: "delete",
    performedBy: dbUser.id, changes: { title: { old: existing.title, new: null } },
  });

  return NextResponse.json({ data: { id } });
}

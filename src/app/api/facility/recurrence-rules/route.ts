import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const createSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  location_id: z.string().uuid(),
  assigned_to: z.string().uuid(),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  cadence_type: z.enum(["daily", "weekly", "monthly"]),
  day_of_week: z.number().int().min(0).max(6).optional(),
  day_of_month: z.number().int().min(1).max(31).optional(),
  skip_if_open: z.boolean().default(true),
}).refine(
  (data) => data.cadence_type !== "weekly" || data.day_of_week !== undefined,
  { message: "day_of_week is required for weekly cadence", path: ["day_of_week"] }
).refine(
  (data) => data.cadence_type !== "monthly" || data.day_of_month !== undefined,
  { message: "day_of_month is required for monthly cadence", path: ["day_of_month"] }
);

/**
 * GET /api/facility/recurrence-rules
 * List all recurring task rules — any authenticated user can view (RLS).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("task_recurrence_rules")
    .select(`
      *,
      location:locations(id, name, code),
      assignee:users!task_recurrence_rules_assigned_to_fkey(id, full_name),
      creator:users!task_recurrence_rules_created_by_fkey(id, full_name)
    `)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/**
 * POST /api/facility/recurrence-rules
 * Create a recurring task rule. Any active user can create one — same
 * "any active user can delegate" model as one-time delegation (see
 * canDelegateTo() in src/lib/facility.ts). Rows are always created_by
 * the caller (enforced by RLS's INSERT policy, not just app logic).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data: assignee } = await supabase
    .from("users").select("id, is_active").eq("id", parsed.data.assigned_to).single();
  if (!assignee?.is_active) {
    return NextResponse.json({ error: "Assignee must be an active user" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("task_recurrence_rules")
    .insert({
      title: parsed.data.title,
      description: parsed.data.description || null,
      location_id: parsed.data.location_id,
      assigned_to: parsed.data.assigned_to,
      priority: parsed.data.priority,
      cadence_type: parsed.data.cadence_type,
      day_of_week: parsed.data.cadence_type === "weekly" ? parsed.data.day_of_week : null,
      day_of_month: parsed.data.cadence_type === "monthly" ? parsed.data.day_of_month : null,
      skip_if_open: parsed.data.skip_if_open,
      created_by: dbUser.id,
    })
    .select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "task_recurrence_rule", entityId: data.id, action: "create",
    performedBy: dbUser.id, changes: { title: { old: null, new: data.title } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

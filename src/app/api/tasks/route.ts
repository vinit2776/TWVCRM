import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTaskSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const status = searchParams.get("status");
  const priority = searchParams.get("priority");
  const assigned_to = searchParams.get("assigned_to");
  const lead_id = searchParams.get("lead_id");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("tasks")
    .select(
      "*, assignee:users!tasks_assigned_to_fkey(*), lead:leads!tasks_lead_id_fkey(id, first_name, last_name)",
      { count: "exact" }
    )
    .is("parent_task_id", null); // Only top-level tasks

  if (status) query = query.eq("status", status);
  if (priority) query = query.eq("priority", priority);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);
  if (lead_id) query = query.eq("lead_id", lead_id);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = createTaskSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      ...result.data,
      created_by: dbUser?.id,
      assigned_to: result.data.assigned_to || dbUser?.id,
    })
    .select("*, assignee:users!tasks_assigned_to_fkey(*)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "task",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  return NextResponse.json({ data }, { status: 201 });
}

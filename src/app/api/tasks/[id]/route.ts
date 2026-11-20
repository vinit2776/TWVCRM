import { NextRequest, NextResponse } from "next/server";
import { canCompleteJob, canEditJob } from "@/lib/handover-jobs";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { notifyRequestTaskDone } from "@/lib/complaint-messages";
import { updateTaskSchema } from "@/lib/validations";
import { logAudit, diffChanges } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("tasks")
    .select("*, assignee:users!tasks_assigned_to_fkey(*), lead:leads!tasks_lead_id_fkey(id, first_name, last_name), subtasks:tasks!tasks_parent_task_id_fkey(*, assignee:users!tasks_assigned_to_fkey(*))")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = updateTaskSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const { data: oldTask } = await supabase.from("tasks").select("*").eq("id", id).single();

  // A hand-over job is finished by the person it was handed to and changed by the person who gave it.
  // tasks is open under row-level security, so this is where it is enforced.
  if (oldTask && oldTask.kind !== "general") {
    const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
    const { status, ...rest } = result.data;
    const completing = status === "done" && oldTask.status !== "done";
    const otherStatusMove = status !== undefined && !completing && status !== oldTask.status;
    // Only fields whose value really changes count, so a form that sends the whole task back is not a change.
    const editsFields = Object.entries(rest).some(([k, v]) => JSON.stringify(v) !== JSON.stringify((oldTask as Record<string, unknown>)[k]));
    const canFinish = canCompleteJob(oldTask, me?.id ?? null, me?.role ?? null);
    const canChange = canEditJob(oldTask, me?.id ?? null, me?.role ?? null);
    if (completing && !canFinish) {
      return NextResponse.json({ error: "Only the person this job was handed to can finish it" }, { status: 403 });
    }
    // A send-a-proposal job finishes when the proposal is sent, not when someone ticks it (an admin can, to clear a stuck one).
    if (completing && oldTask.kind === "send_proposal" && me?.role !== "admin") {
      return NextResponse.json({ error: "This job finishes by itself when the proposal is sent" }, { status: 409 });
    }
    if (otherStatusMove && !canFinish && !canChange) {
      return NextResponse.json({ error: "Only the people on this job can change its status" }, { status: 403 });
    }
    if (editsFields && !canChange) {
      return NextResponse.json({ error: "Only the person who handed this job over can change it" }, { status: 403 });
    }
  }

  const updateData: Record<string, unknown> = { ...result.data };
  if (result.data.status === "done") {
    updateData.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("tasks")
    .update(updateData)
    .eq("id", id)
    .select("*, assignee:users!tasks_assigned_to_fkey(*)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // A task behind a customer request is done: tell the customer. Best effort, never blocks the update.
  if (result.data.status === "done" && oldTask?.status !== "done") {
    try {
      await notifyRequestTaskDone(createAdminClient(), id);
    } catch (err) {
      console.error("[tasks] request notification failed:", err instanceof Error ? err.message : "unknown");
    }
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldTask) {
    logAudit(supabase, {
      entityType: "task",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldTask as Record<string, unknown>, updateData),
    });
  }

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: oldTask } = await supabase.from("tasks").select("*").eq("id", id).single();
  if (oldTask && oldTask.kind !== "general") {
    const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
    if (!canEditJob(oldTask, me?.id ?? null, me?.role ?? null)) {
      return NextResponse.json({ error: "Only the person who handed this job over can remove it" }, { status: 403 });
    }
  }

  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "task",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
      changes: { record: { old: oldTask, new: null } },
    });
  }

  return NextResponse.json({ message: "Task deleted" });
}

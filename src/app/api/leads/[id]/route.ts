import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateLeadSchema } from "@/lib/validations";
import { logAudit, diffChanges } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("leads")
    .select("*, assigned_user:users!leads_assigned_to_fkey(*), location:locations!leads_location_id_fkey(id, name, code), _pending_followups:activities!activities_lead_id_fkey(follow_up_date, is_follow_up_done)")
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  // Ensure tags is always an array (DB default is '{}' but could be null)
  if (data) data.tags = data.tags ?? [];

  // Compute followup flags (same logic as the list endpoint)
  if (data) {
    const today = new Date().toISOString().slice(0, 10);
    type Followup = { follow_up_date: string | null; is_follow_up_done: boolean };
    const pending = ((data._pending_followups as Followup[]) || []).filter(
      (f) => !f.is_follow_up_done && f.follow_up_date
    );
    if (pending.length > 0) {
      const flags = { overdue: false, due_today: false, upcoming: false, earliest_date: "" };
      for (const f of pending) {
        const d = (f.follow_up_date as string).slice(0, 10);
        if (d < today) { flags.overdue = true; if (!flags.earliest_date || d < flags.earliest_date) flags.earliest_date = d; }
        else if (d === today) flags.due_today = true;
        else flags.upcoming = true;
      }
      (data as Record<string, unknown>)._followup = flags;
    }
    delete (data as Record<string, unknown>)._pending_followups;
  }

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = updateLeadSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // Fetch current state for audit diff
  const { data: oldLead } = await supabase.from("leads").select("*").eq("id", id).single();

  const updateData: Record<string, unknown> = { ...result.data };

  // Handle status transitions
  if (result.data.status === "won" && !body.converted_at) {
    updateData.converted_at = new Date().toISOString();
  }
  if (result.data.status === "lost" && !body.lost_at) {
    updateData.lost_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("leads")
    .update(updateData)
    .eq("id", id)
    .select("*, assigned_user:users!leads_assigned_to_fkey(*), location:locations!leads_location_id_fkey(id, name, code)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit log
  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldLead) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldLead as Record<string, unknown>, updateData),
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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Hard delete cascades to proposals/contracts/billing — admin only.
  // Everyone else disables the lead via POST /api/leads/[id]/archive.
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admin can permanently delete a lead. Use Disable instead." },
      { status: 403 }
    );
  }

  // Capture before delete for audit
  const { data: oldLead } = await supabase.from("leads").select("*").eq("id", id).single();

  const { error } = await supabase.from("leads").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
      changes: { record: { old: oldLead, new: null } },
    });
  }

  return NextResponse.json({ message: "Lead deleted" });
}

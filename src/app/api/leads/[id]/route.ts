import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizePhoneFields } from "@/lib/phone";
import { reconcileLeadEnquiries } from "@/lib/enquiry-progress-load";
import { updateLeadSchema } from "@/lib/validations";
import { logAudit, diffChanges, logView } from "@/lib/audit";
import { lostReasonMissing } from "@/lib/lead-close-rules";

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

  // A lead nobody handles can still have an enquiry someone has taken ("X is on it" in the enquiry
  // list). Say so here too, so the two screens do not look like they disagree.
  if (data && !data.assigned_to) {
    const { data: taken } = await supabase
      .from("lead_enquiries")
      .select("claimer:users!lead_enquiries_claimed_by_fkey(full_name)")
      .eq("lead_id", id)
      .not("claimed_by", "is", null)
      .is("resolved_at", null)
      .order("claimed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const claimer = taken?.claimer as { full_name?: string } | { full_name?: string }[] | null | undefined;
    const name = Array.isArray(claimer) ? claimer[0]?.full_name : claimer?.full_name;
    (data as Record<string, unknown>).enquiry_taken_by = name ?? null;
  }

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

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    await logView(supabase, { entityType: "lead", entityId: id, performedBy: dbUser.id });
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

  if (
    lostReasonMissing({
      oldStatus: (oldLead as { status?: string } | null)?.status,
      oldLostReason: (oldLead as { lost_reason?: string | null } | null)?.lost_reason,
      newStatus: result.data.status,
      newLostReason: result.data.lost_reason,
    })
  ) {
    return NextResponse.json({ error: "Say why the lead is lost" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = normalizePhoneFields({ ...result.data });
  // Reopening a junk lead drops its junk reason.
  if ((oldLead as { status?: string } | null)?.status === "junk" && result.data.status && result.data.status !== "junk") {
    updateData.junk_reason = null;
  }

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

  // A lost lead's open enquiries resolve as Not interested; the daily cron is the backstop.
  if (result.data.status === "lost") {
    try {
      await reconcileLeadEnquiries(createAdminClient(), [id]);
    } catch (err) {
      console.error("[lead update] enquiry reconcile failed:", err instanceof Error ? err.message : "unknown");
    }
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

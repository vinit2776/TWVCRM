import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { reconcileLeadEnquiries } from "@/lib/enquiry-progress-load";
import {
  NOT_INTERESTED_REASONS,
  NOT_INTERESTED_REASON_LABELS,
  NOT_INTERESTED_TO_LOST_REASON,
} from "@/lib/constants";

const bodySchema = z.object({
  reason: z.enum(NOT_INTERESTED_REASONS),
  note: z.string().trim().max(1000).optional(),
});

// POST /api/leads/[id]/not-interested
// The one-tap "Not interested" action on the Leads list: records why, closes the lead (lost, or
// junk when it was never a real lead). It does NOT disable the lead: a lost lead stays in the
// list and in search so it can be reviewed or revived, and "disabled" (archive route, admin/manager
// only) is kept for contacts who asked not to be contacted again. A sales rep who just got a "no"
// on the phone has to be able to close their own lead, so this runs under normal lead permissions.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }
  const { reason, note } = parsed.data;

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  const { data: oldLead } = await supabase.from("leads").select("*").eq("id", id).single();
  if (!oldLead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  // Archiving is deliberately limited (see the archive route). A sales rep may close a lead that is
  // theirs, or that nobody has picked up yet; admins and managers may close any.
  const canClose =
    dbUser?.role === "admin" ||
    dbUser?.role === "manager" ||
    (dbUser?.role === "sales_rep" && (!oldLead.assigned_to || oldLead.assigned_to === dbUser.id));
  if (!canClose) {
    return NextResponse.json({ error: "Only the person handling this lead, or a manager, can close it" }, { status: 403 });
  }
  if (oldLead.status === "won") {
    return NextResponse.json({ error: "A won lead can't be closed as not interested" }, { status: 409 });
  }
  if (oldLead.status === "lost" || oldLead.status === "junk") {
    return NextResponse.json({ error: "This lead is already closed" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const label = NOT_INTERESTED_REASON_LABELS[reason];
  const update: Record<string, unknown> =
    reason === "junk"
      ? { status: "junk" }
      : { status: "lost", lost_reason: NOT_INTERESTED_TO_LOST_REASON[reason], lost_at: now };

  const { data, error } = await supabase
    .from("leads")
    .update(update)
    .eq("id", id)
    .eq("status", oldLead.status) // someone else changed it since we read it: don't overwrite
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Whatever was still pending on this lead is no longer a to-do: clear it so it stops showing as
  // overdue and in the digests.
  const { error: doneError } = await supabase
    .from("activities")
    .update({ is_follow_up_done: true, follow_up_actioned_by: dbUser?.id ?? null, follow_up_actioned_at: now })
    .eq("lead_id", id)
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null);
  if (doneError) console.error("[not-interested] clearing follow-ups failed", doneError.code, doneError.message);

  // Keep the reason in the lead's timeline, as the Mark lost dialog does.
  const { error: noteError } = await supabase.from("activities").insert({
    lead_id: id,
    type: "note",
    subject: "Not interested",
    description: note ? `${label}. ${note}` : label,
    created_by: dbUser?.id,
  });
  if (noteError) console.error("[not-interested] timeline note failed", noteError.code, noteError.message);

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: id,
      action: "disable",
      performedBy: dbUser.id,
      changes: {
        status: { old: oldLead.status, new: update.status },
        not_interested_reason: { old: null, new: reason },
      },
    });
  }

  // A closed lead's open enquiries resolve as Not interested; the daily cron is the backstop.
  try {
    await reconcileLeadEnquiries(createAdminClient(), [id]);
  } catch (err) {
    console.error("[not-interested] enquiry reconcile failed:", err instanceof Error ? err.message : "unknown");
  }

  return NextResponse.json({ data });
}

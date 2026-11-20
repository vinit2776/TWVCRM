import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { COORDINATOR_ROLE } from "@/lib/restricted-roles";
import { reconcileLeadEnquiries } from "@/lib/enquiry-progress-load";
import {
  NOT_INTERESTED_REASONS,
  JUNK_REASONS,
  NOT_INTERESTED_REASON_LABELS,
  NOT_INTERESTED_TO_LOST_REASON,
  LEAD_HANDLER_ROLES,
} from "@/lib/constants";

const bodySchema = z.object({
  reason: z.enum(NOT_INTERESTED_REASONS),
  note: z.string().trim().max(1000).optional(),
  /** Only read when reason is junk; a caller that does not say is recorded as "other". */
  junk_reason: z.enum(JUNK_REASONS).optional(),
});

// POST /api/leads/[id]/not-interested
// The one-tap "Not interested" action on the Leads list: records why, closes the lead (lost, or
// junk when it was never a real lead). It does NOT disable the lead: a lost lead stays in the
// list and in search so it can be reviewed or revived, and "disabled" (archive route, admin/manager
// only) is kept for contacts who asked not to be contacted again. Admin, manager, sales rep and coordinator
// may close any lead.
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
  const { reason, note, junk_reason } = parsed.data;

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  const { data: oldLead } = await supabase.from("leads").select("*").eq("id", id).single();
  if (!oldLead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  // Closing is not destructive (the lead stays listed and can be revived), and the person who just
  // heard "no" on the phone is often not the handler (leave, a shared inbox, the coordinator). So any
  // role that works leads may close any lead; the audit trail records who did.
  const canClose = !!dbUser && (LEAD_HANDLER_ROLES as readonly string[]).concat(COORDINATOR_ROLE).includes(dbUser.role);
  if (!canClose) {
    return NextResponse.json({ error: "Your role can't close a lead" }, { status: 403 });
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
      ? { status: "junk", junk_reason: junk_reason ?? "other" }
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

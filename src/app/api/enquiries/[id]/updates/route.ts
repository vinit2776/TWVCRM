import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { loadLeadFacts } from "@/lib/enquiry-progress-load";
import { ENQUIRY_UPDATE_KINDS, ENQUIRY_UPDATE_LABEL, enquiryOutcomeLabel, type EnquiryOutcome } from "@/lib/enquiries";

const bodySchema = z.object({
  kind: z.enum(ENQUIRY_UPDATE_KINDS),
  note: z.string().trim().max(1000).nullable().optional(),
  next_step: z.string().trim().max(500).nullable().optional(),
  // Calendar day (IST) the follow-up is due.
  follow_up_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

async function currentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { supabase, error: NextResponse.json({ error: "User not found" }, { status: 403 }) };
  // The enquiry viewer follows enquiry activity, not the customers: no notes or plans.
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) return { supabase, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { supabase, dbUser };
}

// GET /api/enquiries/[id]/updates — the enquiry's timeline, oldest first: received, claimed,
// every logged update, and the resolution. Received / claimed / resolved are read off the
// enquiry row itself so they can never disagree with it.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, error } = await currentUser();
  if (error) return error;

  const { data: enquiry } = await supabase
    .from("lead_enquiries")
    .select(
      "reference, source, lead_id, received_at, claimed_at, resolved_at, resolved_by, resolution_outcome, " +
        "claimer:users!lead_enquiries_claimed_by_fkey(full_name), resolver:users!lead_enquiries_resolved_by_fkey(full_name)"
    )
    .eq("id", id)
    .single();
  if (!enquiry) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });

  const { data: updates } = await supabase
    .from("enquiry_updates")
    .select("id, kind, note, next_step, follow_up_at, created_at, author:users!enquiry_updates_created_by_fkey(full_name)")
    .eq("enquiry_id", id)
    .order("created_at", { ascending: true });

  // The long selects defeat supabase-js's type parsing, so give the rows their shape.
  const e = enquiry as unknown as {
    lead_id: string | null; received_at: string; claimed_at: string | null; resolved_at: string | null;
    resolved_by: string | null; resolution_outcome: EnquiryOutcome | null;
    claimer: { full_name: string } | null; resolver: { full_name: string } | null;
  };
  const events: { at: string; text: string; by: string | null; auto: boolean; nextStep?: string | null; followUpAt?: string | null }[] = [
    { at: e.received_at, text: "Enquiry received", by: null, auto: true },
  ];
  if (e.claimed_at) events.push({ at: e.claimed_at, text: "Taken on", by: e.claimer?.full_name ?? null, auto: false });
  for (const u of (updates ?? []) as unknown as Array<{
    kind: keyof typeof ENQUIRY_UPDATE_LABEL; note: string | null; next_step: string | null;
    follow_up_at: string | null; created_at: string; author: { full_name: string } | null;
  }>) {
    events.push({
      at: u.created_at,
      text: `${ENQUIRY_UPDATE_LABEL[u.kind]}${u.note ? `: ${u.note}` : ""}`,
      by: u.author?.full_name ?? null,
      auto: false,
      nextStep: u.next_step,
      followUpAt: u.follow_up_at,
    });
  }
  // Proposals and contracts that belong to this enquiry, read from their own records.
  if (e.lead_id) {
    try {
      const facts = (await loadLeadFacts(await createAdminClient(), [e.lead_id])).get(e.lead_id);
      const milestones = facts?.progress.get(id)?.milestones ?? [];
      for (const m of milestones) {
        events.push({ at: m.at, text: `${m.label}${m.ref ? ` (${m.ref})` : ""}`, by: null, auto: true });
      }
    } catch (err) {
      console.error("[enquiry timeline] progress lookup failed:", err instanceof Error ? err.message : "unknown");
    }
  }
  if (e.resolved_at && e.resolution_outcome) {
    // No resolver means the system resolved it (a contract went active, the lead was lost, or
    // it went quiet), as does the 00584 backfill's "superseded".
    const bySystem = !e.resolved_by;
    events.push({
      at: e.resolved_at,
      text: `Resolved: ${enquiryOutcomeLabel(e.resolution_outcome)}${bySystem && e.resolution_outcome !== "superseded" ? " (automatically)" : ""}`,
      by: bySystem ? null : (e.resolver?.full_name ?? null),
      auto: bySystem,
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return NextResponse.json({ data: events });
}

// POST /api/enquiries/[id]/updates
// Logs what happened on one enquiry and sets what comes next. Any authenticated user (same
// as claim). The update's next step REPLACES the enquiry's current plan: leaving it blank
// means nothing is planned, so a stale "call back" never lingers after the call.
// Logging an update on an unclaimed enquiry claims it for the person logging.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, dbUser, error } = await currentUser();
  if (error || !dbUser) return error!;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid update" }, { status: 400 });
  const note = parsed.data.note || null;
  const nextStep = parsed.data.next_step || null;
  const followUpDate = parsed.data.follow_up_date ?? null;
  if (!nextStep && followUpDate) {
    return NextResponse.json({ error: "Add a next step to go with the follow-up date" }, { status: 400 });
  }
  if (parsed.data.kind === "note" && !note && !nextStep) {
    return NextResponse.json({ error: "Add a note or a next step" }, { status: 400 });
  }

  // lead_enquiries / enquiry_updates are read-only to users under RLS; this route writes.
  const admin = await createAdminClient();
  const { data: old } = await admin
    .from("lead_enquiries")
    .select("reference, lead_id, claimed_by, resolved_at, next_step, follow_up_at")
    .eq("id", id)
    .single();
  if (!old) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  if (old.resolved_at) return NextResponse.json({ error: "This enquiry is already resolved" }, { status: 409 });

  const now = new Date().toISOString();
  const followUpAt = followUpDate ? `${followUpDate}T00:00:00+05:30` : null;

  const { error: insertError } = await admin.from("enquiry_updates").insert({
    enquiry_id: id,
    kind: parsed.data.kind,
    note,
    next_step: nextStep,
    follow_up_at: followUpAt,
    created_by: dbUser.id,
  });
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  const update: Record<string, unknown> = {
    next_step: nextStep,
    follow_up_at: followUpAt,
    next_step_by: nextStep ? dbUser.id : null,
    next_step_at: nextStep ? now : null,
  };
  if (!old.claimed_by) {
    update.claimed_by = dbUser.id;
    update.claimed_at = now;
  }
  const { error: updateError } = await admin.from("lead_enquiries").update(update).eq("id", id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  if (old.lead_id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: old.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        enquiry: { old: old.reference, new: old.reference },
        enquiry_update: { old: null, new: parsed.data.kind },
        next_step: { old: old.next_step, new: nextStep },
        follow_up_at: { old: old.follow_up_at, new: followUpAt },
      },
    });
  }

  return NextResponse.json({ success: true });
}

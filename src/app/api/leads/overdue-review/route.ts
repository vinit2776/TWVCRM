import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { soonestPerLead } from "@/lib/follow-up-groups";
import { reconcileLeadEnquiries } from "@/lib/enquiry-progress-load";
import {
  REVIEW_ACTIONS,
  REVIEW_BATCH_MAX,
  canActOnPileLead,
  newDateProblem,
  parseReviewMode,
  reviewPile,
  snoozedTo,
  type PileRow,
} from "@/lib/lead-overdue-review";

const MAX_PENDING = 10000;
const CLOSED_STATUSES = "(won,lost,junk)";
const LIST_MAX = 200;

type SupabaseUser = Awaited<ReturnType<typeof createClient>>;

async function loadContext(supabase: SupabaseUser) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me) return null;
  const admin = await createAdminClient();
  const { data: setting } = await admin.from("app_settings").select("value").eq("key", "lead_overdue_review_mode").maybeSingle();
  return { me: me as { id: string; role: string }, mode: parseReviewMode(setting?.value) };
}

/** Every open lead's soonest pending follow-up, as the Follow-ups tab reads it, narrowed to the pile. */
async function loadPile(supabase: SupabaseUser): Promise<{ pile: PileRow[]; notes: Map<string, string> } | null> {
  const { data, error } = await supabase
    .from("activities")
    .select("lead_id, follow_up_date, follow_up_notes, leads!inner(id)")
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null)
    .is("leads.archived_at", null)
    .not("leads.status", "in", CLOSED_STATUSES)
    .limit(MAX_PENDING);
  if (error) {
    console.error("[overdue-review] load failed", error.code, error.message);
    return null;
  }
  const rows = (data ?? []) as unknown as { lead_id: string; follow_up_date: string; follow_up_notes: string | null }[];
  const nextDue = soonestPerLead(rows);
  const notes = new Map<string, string>();
  for (const r of rows) {
    if (r.follow_up_notes && r.follow_up_date === nextDue.get(r.lead_id)) notes.set(r.lead_id, r.follow_up_notes);
  }
  return { pile: reviewPile(nextDue), notes };
}

// GET /api/leads/overdue-review?assigned_to=<id>
// The leads whose next step is 14+ days past due, most overdue first, with who has them and what the
// next step was. Read-only. The mode says whether the review is hidden, a preview, or live.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const ctx = await loadContext(supabase);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.mode === "off") return NextResponse.json({ mode: ctx.mode, total: 0, rows: [] });

  const assignedTo = new URL(request.url).searchParams.get("assigned_to");
  if (assignedTo && !/^[0-9a-f-]{36}$/i.test(assignedTo)) return NextResponse.json({ error: "Bad assigned_to" }, { status: 400 });

  const loaded = await loadPile(supabase);
  if (!loaded) return NextResponse.json({ error: "Could not load the review" }, { status: 500 });

  const ids = loaded.pile.map((p) => p.leadId);
  type LeadRow = { id: string; first_name: string | null; last_name: string | null; status: string; assigned_to: string | null; owner: { full_name: string | null } | null };
  const leads = new Map<string, LeadRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from("leads")
      .select("id, first_name, last_name, status, assigned_to, owner:users!leads_assigned_to_fkey(full_name)")
      .in("id", ids.slice(i, i + 200));
    for (const l of (data ?? []) as unknown as LeadRow[]) leads.set(l.id, l);
  }

  const rows = loaded.pile
    .filter((p) => !assignedTo || leads.get(p.leadId)?.assigned_to === assignedTo)
    .map((p) => {
      const l = leads.get(p.leadId);
      return {
        lead_id: p.leadId,
        name: `${l?.first_name ?? ""} ${l?.last_name ?? ""}`.trim() || "Unknown",
        status: l?.status ?? null,
        owner_id: l?.assigned_to ?? null,
        owner_name: l?.owner?.full_name ?? null,
        due_at: p.dueAt,
        days_overdue: p.daysOverdue,
        next_step: loaded.notes.get(p.leadId) ?? null,
        can_act: canActOnPileLead(ctx.me.role, ctx.me.id, l?.assigned_to ?? null),
      };
    });

  return NextResponse.json({ mode: ctx.mode, total: rows.length, rows: rows.slice(0, LIST_MAX) });
}

const bodySchema = z
  .object({
    action: z.enum(REVIEW_ACTIONS),
    lead_ids: z.array(z.string().uuid()).min(1).max(REVIEW_BATCH_MAX),
    date: z.string().optional(),
  })
  .strict();

// POST /api/leads/overdue-review { action, lead_ids, date? }
// Snooze or re-date the overdue next step, or close the lead as no response. Only leads that are in
// the pile right now and that the caller may act on are touched; the rest come back as skipped. In
// preview mode nothing is written and the response says what would change. Never contacts a customer.
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const ctx = await loadContext(supabase);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.mode === "off") return NextResponse.json({ error: "The overdue review is not switched on" }, { status: 409 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  const { action, date } = parsed.data;
  const leadIds = [...new Set(parsed.data.lead_ids)];

  let newDate: string | null = null;
  if (action === "snooze") newDate = snoozedTo();
  if (action === "new_date") {
    const problem = newDateProblem(date);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    newDate = new Date(date as string).toISOString();
  }

  const loaded = await loadPile(supabase);
  if (!loaded) return NextResponse.json({ error: "Could not load the review" }, { status: 500 });
  const inPile = new Map(loaded.pile.map((p) => [p.leadId, p]));

  const { data: leadRows } = await supabase.from("leads").select("id, first_name, last_name, assigned_to").in("id", leadIds);
  const leads = new Map(((leadRows ?? []) as { id: string; first_name: string | null; last_name: string | null; assigned_to: string | null }[]).map((l) => [l.id, l]));

  const planned: { lead_id: string; name: string; from: string; to: string | null }[] = [];
  const skipped: { lead_id: string; reason: string }[] = [];
  for (const id of leadIds) {
    const row = inPile.get(id);
    const lead = leads.get(id);
    if (!row || !lead) skipped.push({ lead_id: id, reason: "No longer overdue by 14 days" });
    else if (!canActOnPileLead(ctx.me.role, ctx.me.id, lead.assigned_to)) skipped.push({ lead_id: id, reason: "Not your lead" });
    else planned.push({ lead_id: id, name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "Unknown", from: row.dueAt, to: action === "close_no_response" ? null : newDate });
  }

  if (ctx.mode === "dry_run") return NextResponse.json({ dry_run: true, action, planned, skipped });

  const done: string[] = [];
  const failed: { lead_id: string; reason: string }[] = [];
  const now = new Date().toISOString();
  for (const p of planned) {
    if (action === "close_no_response") {
      // Compare-and-set: only a lead that is still open is closed, so two people cannot both do it.
      const { data, error } = await supabase
        .from("leads")
        .update({ status: "lost", lost_reason: "no_response", lost_at: now })
        .eq("id", p.lead_id)
        .not("status", "in", CLOSED_STATUSES)
        .select("id");
      if (error || !data || data.length === 0) {
        failed.push({ lead_id: p.lead_id, reason: error ? "Could not close it" : "Already closed" });
        continue;
      }
      try {
        await reconcileLeadEnquiries(await createAdminClient(), [p.lead_id]);
      } catch (e) {
        console.error("[overdue-review] enquiry reconcile failed:", e instanceof Error ? e.message : "unknown");
      }
      logAudit(supabase, {
        entityType: "lead",
        entityId: p.lead_id,
        action: "update",
        performedBy: ctx.me.id,
        changes: { status: { old: "open", new: "lost" }, lost_reason: { old: null, new: "no_response" }, overdue_review: { old: p.from, new: "closed as no response" } },
      });
    } else {
      // Every follow-up on this lead that is still pending and past due moves to the new date.
      const { data, error } = await supabase
        .from("activities")
        .update({ follow_up_date: p.to, updated_at: now })
        .eq("lead_id", p.lead_id)
        .eq("is_follow_up_done", false)
        .lt("follow_up_date", now)
        .select("id");
      if (error || !data || data.length === 0) {
        failed.push({ lead_id: p.lead_id, reason: error ? "Could not move it" : "Nothing to move" });
        continue;
      }
      logAudit(supabase, {
        entityType: "lead",
        entityId: p.lead_id,
        action: "update",
        performedBy: ctx.me.id,
        changes: { overdue_review: { old: p.from, new: `${action === "snooze" ? "snoozed" : "moved"} to ${p.to}` } },
      });
    }
    done.push(p.lead_id);
  }

  return NextResponse.json({ dry_run: false, action, done, failed, skipped });
}

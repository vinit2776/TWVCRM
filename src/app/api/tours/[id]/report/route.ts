import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/in-app-notifications";
import { REPORT_MAX_PHOTOS, TOUR_REPORT_OUTCOME_LABELS, canWorkTour, photoPathOk, reportProblem, type TourReportOutcome } from "@/lib/tour-reports";

const postSchema = z.object({
  outcome: z.string().max(40),
  comments: z.string().max(4000),
  photos: z.array(z.object({ file_path: z.string().max(500), caption: z.string().trim().max(200).nullish() })).max(REPORT_MAX_PHOTOS + 1),
  accompanier_note: z.string().trim().max(2000).nullish(),
});
const noteSchema = z.object({ accompanier_note: z.string().trim().min(1).max(2000) });

async function load(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: me } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!me || !([...LEAD_HANDLER_ROLES, "floor_manager"] as readonly string[]).includes(me.role)) {
    return { error: NextResponse.json({ error: "Only admin, manager, sales and floor roles can report on a tour" }, { status: 403 }) } as const;
  }
  const { data: tour } = await supabase
    .from("activities")
    .select("id, type, lead_id, tour_outcome, tour_host_id, accompanier_id, created_by, lead:leads!activities_lead_id_fkey(first_name, last_name, assigned_to, location_id)")
    .eq("id", id)
    .single();
  if (!tour || tour.type !== "tour") return { error: NextResponse.json({ error: "Tour not found" }, { status: 404 }) } as const;
  const lead = (tour as unknown as { lead: { first_name: string; last_name: string | null; assigned_to: string | null; location_id: string | null } | null }).lead;
  let inchargeIds: string[] = [];
  if (me.role === "floor_manager" && lead?.location_id) {
    const { data: loc } = await createAdminClient().from("locations").select("incharge_user_id_1, incharge_user_id_2").eq("id", lead.location_id).maybeSingle();
    inchargeIds = [loc?.incharge_user_id_1, loc?.incharge_user_id_2].filter((x): x is string => !!x);
  }
  const people = { hostId: tour.tour_host_id, accompanierId: tour.accompanier_id, createdBy: tour.created_by, leadOwnerId: lead?.assigned_to ?? null, inchargeIds };
  if (!canWorkTour(me.role, me.id, people)) return { error: NextResponse.json({ error: "This tour is not at your centre" }, { status: 403 }) } as const;
  return { supabase, me, tour, lead } as const;
}

// GET /api/tours/[id]/report: the visit report with signed photo links, or null when there is none yet.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await load(id);
  if ("error" in ctx) return ctx.error;
  const admin = createAdminClient();
  const { data: report } = await admin
    .from("tour_reports")
    .select("id, outcome, comments, accompanier_note, created_at, reporter:users!tour_reports_reported_by_fkey(full_name), tour_report_photos(id, file_path, caption)")
    .eq("activity_id", id)
    .maybeSingle();
  if (!report) return NextResponse.json({ data: null });
  const photos = await Promise.all(
    ((report as unknown as { tour_report_photos: { id: string; file_path: string; caption: string | null }[] }).tour_report_photos ?? []).map(async (p) => {
      const { data: signed } = await admin.storage.from("facility-issue-photos").createSignedUrl(p.file_path, 60 * 60);
      return { id: p.id, caption: p.caption, url: signed?.signedUrl ?? null };
    }),
  );
  return NextResponse.json({ data: { ...report, tour_report_photos: undefined, photos } });
}

// POST /api/tours/[id]/report { outcome, comments, photos: [{file_path}], accompanier_note? }
// The host's visit report, once per tour: how it went, comments and at least one photo, uploaded to
// tour-reports/<tour>/ first. It records that the customer came, puts a line on the lead's timeline,
// tells the person who booked it and the accompanier, and (when hand-over jobs are on) gives the
// caller a "set the next step" job. Nothing here contacts the customer.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await load(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, me, tour, lead } = ctx;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  const body = parsed.data;
  const paths = body.photos.map((p) => p.file_path);

  const problem = reportProblem({ outcome: body.outcome, comments: body.comments, photoPaths: paths });
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (!paths.every((p) => photoPathOk(id, p))) return NextResponse.json({ error: "A photo is not from this tour's upload" }, { status: 400 });
  if (tour.tour_outcome === "no_show" || tour.tour_outcome === "cancelled") {
    return NextResponse.json({ error: "This tour was marked as not held, so it cannot have a visit report" }, { status: 409 });
  }

  const admin = createAdminClient();
  const { data: report, error } = await admin
    .from("tour_reports")
    .insert({ activity_id: id, lead_id: tour.lead_id, reported_by: me.id, outcome: body.outcome, comments: body.comments.trim(), accompanier_note: body.accompanier_note || null })
    .select("id")
    .single();
  if (error) {
    // The unique key on activity_id: one report per tour.
    if (error.code === "23505") return NextResponse.json({ error: "This tour already has a visit report" }, { status: 409 });
    console.error("[tour report] insert failed", error.code, error.message);
    return NextResponse.json({ error: "Could not save the report" }, { status: 500 });
  }
  const { error: photoError } = await admin.from("tour_report_photos").insert(body.photos.map((p) => ({ report_id: report.id, file_path: p.file_path, caption: p.caption ?? null })));
  if (photoError) {
    // Never leave a report without its photos: undo it so the host can try again.
    await admin.from("tour_reports").delete().eq("id", report.id);
    console.error("[tour report] photo insert failed", photoError.code, photoError.message);
    return NextResponse.json({ error: "Could not save the photos" }, { status: 500 });
  }

  const now = new Date().toISOString();
  const label = TOUR_REPORT_OUTCOME_LABELS[body.outcome as TourReportOutcome];
  // A report means the visit happened: record that, the same way "came" does.
  if (!tour.tour_outcome) {
    await supabase.from("activities").update({ tour_outcome: "came", tour_outcome_at: now, tour_outcome_by: me.id, is_follow_up_done: true, follow_up_actioned_by: me.id, follow_up_actioned_at: now, updated_at: now }).eq("id", id).is("tour_outcome", null);
    await autoUpdateLeadStatus(supabase, tour.lead_id, "tour", { meetingEndAt: now });
  }
  await supabase.from("activities").insert({ lead_id: tour.lead_id, type: "note", subject: "Tour report", description: `${label}: ${body.comments.trim()} (${paths.length} photo${paths.length === 1 ? "" : "s"})`, created_by: me.id });
  logAudit(supabase, { entityType: "lead", entityId: tour.lead_id, action: "update", performedBy: me.id, changes: { tour_report: { old: null, new: body.outcome } } });

  const name = `${lead?.first_name ?? ""} ${lead?.last_name === "-" ? "" : (lead?.last_name ?? "")}`.trim() || "the customer";
  const { data: flag } = await admin.from("app_settings").select("value").eq("key", "handover_jobs_enabled").maybeSingle();
  if (flag?.value === "true" && tour.created_by && tour.created_by !== me.id) {
    await admin.from("tasks").insert({
      title: `Set the next step for ${name}`,
      description: body.comments.trim(),
      status: "todo",
      priority: "medium",
      lead_id: tour.lead_id,
      assigned_to: tour.created_by,
      tags: [] as string[],
      kind: "other",
      brief: { discussed: `${label}. ${body.comments.trim()}`, proposal_kind: null },
      created_by: me.id,
      handed_over_by: me.id,
    });
  }
  for (const uid of new Set([tour.created_by, tour.accompanier_id].filter((x): x is string => !!x && x !== me.id))) {
    await createNotification({ userId: uid, type: "tour_report", title: `Visit report: ${name}`, body: `${label}. ${paths.length} photo${paths.length === 1 ? "" : "s"}.`, url: `/leads/${tour.lead_id}`, entityType: "lead", entityId: tour.lead_id }).catch(() => {});
  }
  return NextResponse.json({ data: { id: report.id } }, { status: 201 });
}

// PATCH /api/tours/[id]/report { accompanier_note }: the person who accompanied adds their own note.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await load(id);
  if ("error" in ctx) return ctx.error;
  const { me, tour } = ctx;
  if (tour.accompanier_id !== me.id && !LEAD_HANDLER_ROLES.includes(me.role as (typeof LEAD_HANDLER_ROLES)[number])) {
    return NextResponse.json({ error: "Only the person who accompanied the tour can add a note" }, { status: 403 });
  }
  const parsed = noteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Add a note" }, { status: 400 });
  const { data, error } = await createAdminClient().from("tour_reports").update({ accompanier_note: parsed.data.accompanier_note }).eq("activity_id", id).select("id");
  if (error) return NextResponse.json({ error: "Could not save the note" }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ error: "There is no report yet" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

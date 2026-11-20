import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { createNotification } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { JOB_KINDS, JOB_KIND_LABELS, defaultJobTitle } from "@/lib/handover-jobs";

const jobSchema = z
  .object({
    kind: z.enum(JOB_KINDS),
    assigned_to: z.string().uuid(),
    /** Needed for "something else"; the other kinds are titled after the customer. */
    title: z.string().trim().max(200).optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    discussed: z.string().trim().max(2000).optional(),
    proposal_kind: z.string().trim().max(500).optional(),
  })
  .refine((j) => j.kind !== "other" || !!j.title, { message: "Say what the job is", path: ["title"] });

const bodySchema = z.object({ jobs: z.array(jobSchema).min(1).max(5) });

// POST /api/leads/[id]/handover
// "Priya, send a proposal to this customer": one job per step, kept on the tasks table with what the
// giver wrote for the person doing it. Staff only; nothing is sent to the customer. Each person it is
// given to is told in the app and by push (not when they give a job to themselves).
// Admin, manager and sales rep may hand over; the job goes to an active admin, manager or sales rep.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Bad lead id" }, { status: 400 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Your role can't hand over a job" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });

  const admin = await createAdminClient();
  const { data: flag } = await admin.from("app_settings").select("value").eq("key", "handover_jobs_enabled").maybeSingle();
  if (flag?.value !== "true") return NextResponse.json({ error: "Handing over jobs is not switched on yet" }, { status: 409 });

  const { data: lead } = await supabase.from("leads").select("id, first_name, last_name, status").eq("id", id).single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (lead.status === "won" || lead.status === "lost" || lead.status === "junk") {
    return NextResponse.json({ error: "This lead is closed" }, { status: 409 });
  }
  const leadName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();

  const assigneeIds = [...new Set(parsed.data.jobs.map((j) => j.assigned_to))];
  const { data: people } = await admin.from("users").select("id, role, is_active").in("id", assigneeIds);
  const okPeople = new Set(
    (people ?? []).filter((p) => p.is_active && (LEAD_HANDLER_ROLES as readonly string[]).includes(p.role)).map((p) => p.id as string),
  );
  if (assigneeIds.some((a) => !okPeople.has(a))) {
    return NextResponse.json({ error: "A job can only go to an active admin, manager or sales rep" }, { status: 400 });
  }

  const rows = parsed.data.jobs.map((j) => ({
    title: j.title || defaultJobTitle(j.kind, leadName),
    description: j.discussed || null,
    status: "todo" as const,
    priority: "medium" as const,
    lead_id: id,
    assigned_to: j.assigned_to,
    due_date: j.due_date ?? null,
    tags: [] as string[],
    kind: j.kind,
    brief: j.discussed || j.proposal_kind ? { discussed: j.discussed ?? null, proposal_kind: j.proposal_kind ?? null } : null,
    created_by: me.id,
    handed_over_by: me.id,
  }));
  const { data: created, error } = await admin.from("tasks").insert(rows).select("id, title, kind, assigned_to");
  if (error || !created) {
    console.error("[handover] insert failed", error?.code, error?.message);
    return NextResponse.json({ error: "Could not hand the job over" }, { status: 500 });
  }

  for (const t of created) {
    logAudit(supabase, {
      entityType: "task",
      entityId: t.id as string,
      action: "create",
      performedBy: me.id,
      changes: { handed_over: { old: null, new: `${JOB_KIND_LABELS[t.kind as keyof typeof JOB_KIND_LABELS]} → ${t.assigned_to}` } },
    });
    // Told in the app and by push; a job given to yourself needs no message.
    if (t.assigned_to && t.assigned_to !== me.id) {
      const body = `${me.full_name} handed you a job for ${leadName || "a customer"}`;
      await createNotification({
        userId: t.assigned_to as string,
        type: "handover_job",
        title: t.title as string,
        body,
        url: "/leads?view=home",
        entityType: "task",
        entityId: t.id as string,
      });
      void sendPushToUsers([t.assigned_to as string], { title: t.title as string, body, url: "/leads?view=home", tag: `task-${t.id}` }).catch(() => {});
    }
  }

  return NextResponse.json({ data: created }, { status: 201 });
}

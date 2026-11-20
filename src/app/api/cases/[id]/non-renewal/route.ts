import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { latestLapseDecision, LAPSE_DECISION_ROLES } from "@/lib/vo-lapse-decision";
import {
  MARKABLE_KEYS,
  computeChecklist,
  draftSecondRequest,
  markBlocker,
  placeKindForPurpose,
  type DocSummary,
  type MarkableKey,
  type StepMarks,
} from "@/lib/vo-non-renewal";

/**
 * GET  /api/cases/[id]/non-renewal — the non-renewal checklist of a lapsed case.
 * POST /api/cases/[id]/non-renewal — mark one step.
 *
 * Nothing is sent from here. The second confirmation request is returned as a
 * draft for a person to send themselves; marking it only records that it was drafted.
 *
 * Deploy comes before the migration: while vo_non_renewal_steps is missing
 * (42P01, or PGRST205 from the PostgREST schema cache) the GET reports `available: false` and the POST refuses with 503.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  step: z.enum(MARKABLE_KEYS),
  // Only the portal check has an outcome; everything else is simply done.
  outcome: z.enum(["done", "issue"]).default("done"),
  note: z.string().trim().max(500).optional(),
});

// "Not migrated yet": Postgres undefined_table / undefined_column, and PostgREST schema-cache misses
// (PGRST205 table, PGRST204 column), which is what the API answers when the cache has not reloaded.
const NOT_MIGRATED = new Set(["42P01", "42703", "PGRST205", "PGRST204"]);

async function authorise() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { dbUser: dbUser as { id: string; role: string } };
}

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

async function loadState(admin: AdminClient, id: string) {
  const { data: c } = await admin
    .from("cases")
    .select("id, case_number, status, purpose, client_name, client_company_name, metadata, location:locations!cases_location_id_fkey(name)")
    .eq("id", id)
    .maybeSingle();
  if (!c) return { notFound: true as const };

  const [{ data: docs }, stepsRes] = await Promise.all([
    admin.from("vo_discontinuation_documents").select("document_type, status").eq("case_id", id),
    admin.from("vo_non_renewal_steps").select("step_key, status, done_at, note").eq("case_id", id),
  ]);
  if (stepsRes.error) {
    if (NOT_MIGRATED.has(stepsRes.error.code ?? "")) return { c, available: false as const };
    throw new Error(stepsRes.error.message);
  }
  const marks: StepMarks = {};
  for (const r of (stepsRes.data ?? []) as { step_key: MarkableKey; status: "done" | "issue"; done_at: string; note: string | null }[]) {
    marks[r.step_key] = { status: r.status, done_at: r.done_at, note: r.note };
  }
  return { c, available: true as const, docs: (docs ?? []) as DocSummary[], marks };
}

function isActive(c: { status: string; metadata: unknown }) {
  return c.status === "lapsed" && latestLapseDecision(c.metadata)?.decision === "discontinue";
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;

  const admin = await createAdminClient();
  const s = await loadState(admin, id);
  if ("notFound" in s) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!s.available) return NextResponse.json({ data: { available: false } });

  const now = new Date().toISOString();
  const result = computeChecklist({ purpose: s.c.purpose, docs: s.docs, marks: s.marks, now });
  const requestedAt = s.marks.confirmation_requested?.done_at;
  const location = s.c.location as { name?: string } | null;
  const secondRequestDraft =
    requestedAt && result.overdue && !s.marks.confirmation_received
      ? draftSecondRequest({
          clientName: s.c.client_company_name || s.c.client_name,
          caseNumber: s.c.case_number,
          locationName: location?.name ?? "The WorkVilla",
          kind: result.kind,
          requestedAt,
        })
      : null;

  return NextResponse.json({
    data: {
      available: true,
      active: isActive(s.c),
      can_act: LAPSE_DECISION_ROLES.includes(auth.dbUser.role),
      steps: result.steps,
      badge: result.badge,
      deadline: result.deadline,
      overdue: result.overdue,
      marks: s.marks,
      second_request_draft: secondRequestDraft,
    },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;
  if (!LAPSE_DECISION_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin or manager can update the non-renewal checklist" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { step, note } = parsed.data;
  const outcome = step === "gst_portal_check" ? parsed.data.outcome : "done";

  const admin = await createAdminClient();
  const s = await loadState(admin, id);
  if ("notFound" in s) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!s.available) {
    return NextResponse.json({ error: "The checklist is not available yet. The database update has not been applied." }, { status: 503 });
  }
  if (!isActive(s.c)) {
    return NextResponse.json({ error: "Record the decision to discontinue on this case first." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const kind = placeKindForPurpose(s.c.purpose);
  const blocker = markBlocker(step, { docs: s.docs, marks: s.marks, now, kind });
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });
  if (s.marks[step]?.status === "done") {
    return NextResponse.json({ error: "This step is already recorded." }, { status: 409 });
  }

  const { error } = await admin
    .from("vo_non_renewal_steps")
    .upsert(
      { case_id: id, step_key: step, status: outcome, done_at: now, done_by: dbUser.id, note: note ?? null },
      { onConflict: "case_id,step_key" },
    );
  if (error) {
    if (NOT_MIGRATED.has(error.code ?? "")) {
      return NextResponse.json({ error: "The checklist is not available yet. The database update has not been applied." }, { status: 503 });
    }
    return NextResponse.json({ error: "Could not save the step. Nothing was changed." }, { status: 500 });
  }

  // Mirror onto the case for lists and filters. Best effort: the steps table is the record.
  const marks: StepMarks = { ...s.marks, [step]: { status: outcome, done_at: now } };
  const result = computeChecklist({ purpose: s.c.purpose, docs: s.docs, marks, now });
  const mirror: Record<string, string> = { release_status: result.badge };
  const column: Partial<Record<MarkableKey, string>> = {
    delivered: "delivered_at",
    confirmation_requested: "confirmation_requested_at",
    confirmation_second_request: "confirmation_second_request_at",
    confirmation_received: "confirmation_received_at",
    gst_portal_check: "gst_portal_checked_at",
  };
  if (column[step]) mirror[column[step]!] = now;
  const { error: mirrorError } = await admin.from("cases").update(mirror).eq("id", id);
  if (mirrorError && !NOT_MIGRATED.has(mirrorError.code ?? "")) {
    console.error("[non-renewal] case mirror failed:", mirrorError.message);
  }

  logAudit(admin, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "non_renewal_step_marked" },
      step: { old: null, new: step },
      outcome: { old: null, new: outcome },
    },
  });
  return NextResponse.json({ data: { step, status: outcome, badge: result.badge } });
}

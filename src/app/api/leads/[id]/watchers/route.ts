import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { canBeKeptInformed, daysLeft, loopinExpiry, loopinProblem, watcherState } from "@/lib/lead-loopin";

const addSchema = z.object({ user_ids: z.array(z.string().uuid()).min(1).max(10), reason: z.string().trim().max(500) });
const answerSchema = z.object({ answer: z.enum(["got_it", "not_for_me"]) });

async function context(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: me } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return { error: NextResponse.json({ error: "Only admin, manager and sales roles can use Keep informed" }, { status: 403 }) } as const;
  }
  const admin = createAdminClient();
  const { data: flag } = await admin.from("app_settings").select("value").eq("key", "lead_loopin_enabled").maybeSingle();
  if (flag?.value !== "true") return { error: NextResponse.json({ error: "Keep informed is not switched on yet" }, { status: 409 }) } as const;
  const { data: lead } = await supabase.from("leads").select("id, status, archived_at, first_name, last_name").eq("id", id).single();
  if (!lead) return { error: NextResponse.json({ error: "Lead not found" }, { status: 404 }) } as const;
  return { supabase, admin, me, lead } as const;
}

// GET /api/leads/[id]/watchers
// Who is kept informed on this lead, why, who asked, and whether they have answered. Read-only.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await context(id);
  if ("error" in ctx) return ctx.error;
  const { data, error } = await ctx.supabase
    .from("lead_watchers")
    .select("id, user_id, reason, created_at, expires_at, answer, answered_at, person:users!lead_watchers_user_id_fkey(full_name), adder:users!lead_watchers_added_by_fkey(full_name)")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[watchers] load failed", error.code, error.message);
    return NextResponse.json({ error: "Could not load who is kept informed" }, { status: 500 });
  }
  type Row = { id: string; user_id: string; reason: string; created_at: string; expires_at: string; answer: string | null; answered_at: string | null; person: { full_name: string } | null; adder: { full_name: string } | null };
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.person?.full_name ?? "Someone",
    addedBy: r.adder?.full_name ?? null,
    reason: r.reason,
    addedAt: r.created_at,
    state: watcherState(r),
    daysLeft: daysLeft(r.expires_at),
  }));
  return NextResponse.json({ data: rows });
}

// POST /api/leads/[id]/watchers { user_ids, reason }
// Ask colleagues who work leads to keep an eye on this one. They get no job and nothing goes to the
// customer; they see it in Leads Home until they answer or it clears itself after 14 days. Asking
// again for someone resets their row.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await context(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, admin, me, lead } = ctx;
  if (["won", "lost", "junk"].includes(lead.status) || lead.archived_at) return NextResponse.json({ error: "This lead is closed" }, { status: 409 });

  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Pick people and say why" }, { status: 400 });
  const { user_ids: userIds, reason } = parsed.data;
  const problem = loopinProblem({ userIds, reason, addedBy: me.id });
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const { data: people } = await admin.from("users").select("id, role, full_name").in("id", userIds).eq("is_active", true);
  const ok = (people ?? []).filter((p) => canBeKeptInformed(p.role, LEAD_HANDLER_ROLES));
  if (ok.length !== userIds.length) return NextResponse.json({ error: "Only active admin, manager and sales people can be kept informed" }, { status: 400 });

  const now = new Date();
  const { error } = await admin.from("lead_watchers").upsert(
    ok.map((p) => ({ lead_id: id, user_id: p.id, added_by: me.id, reason: reason.trim(), created_at: now.toISOString(), expires_at: loopinExpiry(now), answer: null, answered_at: null })),
    { onConflict: "lead_id,user_id" },
  );
  if (error) {
    console.error("[watchers] add failed", error.code, error.message);
    return NextResponse.json({ error: "Could not keep them informed" }, { status: 500 });
  }

  const name = `${lead.first_name} ${lead.last_name === "-" ? "" : (lead.last_name ?? "")}`.trim();
  await createNotificationsForUsers(ok.map((p) => p.id), {
    type: "lead_kept_informed",
    title: `${me.full_name} kept you informed on ${name}`,
    body: reason.trim(),
    url: `/leads/${id}/activity`,
    entityType: "lead",
    entityId: id,
  });
  await supabase.from("activities").insert({
    lead_id: id,
    type: "note",
    subject: "Kept informed",
    description: `${ok.map((p) => p.full_name).join(", ")} kept informed by ${me.full_name}: ${reason.trim()}`,
    created_by: me.id,
  });
  logAudit(supabase, { entityType: "lead", entityId: id, action: "update", performedBy: me.id, changes: { kept_informed: { old: null, new: ok.map((p) => p.full_name).join(", ") } } });
  return NextResponse.json({ ok: true }, { status: 201 });
}

// PATCH /api/leads/[id]/watchers { answer }
// The signed-in colleague answers for themselves: "got_it" or "not_for_me". Only a row still
// waiting (not answered, not expired) can be answered, so it is a compare-and-set.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await context(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, admin, me } = ctx;
  const parsed = answerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Answer Got it or Not for me" }, { status: 400 });

  const now = new Date().toISOString();
  const { data: done } = await admin
    .from("lead_watchers")
    .update({ answer: parsed.data.answer, answered_at: now })
    .eq("lead_id", id)
    .eq("user_id", me.id)
    .is("answer", null)
    .gt("expires_at", now)
    .select("id");
  if (!done || done.length === 0) return NextResponse.json({ error: "Nothing waiting for you on this lead" }, { status: 409 });
  logAudit(supabase, { entityType: "lead", entityId: id, action: "update", performedBy: me.id, changes: { kept_informed_answer: { old: null, new: parsed.data.answer } } });
  return NextResponse.json({ ok: true });
}

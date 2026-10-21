import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { submitSpecialClause, decideSpecialClause, withdrawSpecialClause, type SubjectKind } from "./service";
import { requireActor } from "./route-helpers";

// One implementation behind both /api/contracts/[id]/special-clause and
// /api/cases/[id]/special-clause, so the two can't drift apart.

const reportSchema = z.object({
  restated_intent: z.string(),
  kept: z.array(z.string()),
  added: z.array(z.string()),
  topics_checked: z.array(z.string()),
  rounds: z.number(),
});

const submitSchema = z.object({
  intent: z.string().trim().min(10).max(1500),
  reason: z.string().trim().min(10).max(1500),
  clause_text: z.string().trim().min(20).max(4000),
  review_token: z.string().min(10),
  report: reportSchema,
});

const decisionSchema = z.object({
  revision_id: z.string().uuid(),
  decision: z.enum(["approve", "request_changes"]),
  note: z.string().max(2000).optional(),
  required_changes: z.string().max(2000).optional(),
});

const badRequest = (error: z.ZodError) =>
  NextResponse.json({ error: error.issues.map((i) => i.message).join("; ") }, { status: 400 });

export async function listClauses(kind: SubjectKind, id: string) {
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const { data, error } = await supabase
    .from("special_clauses")
    .select("*, submitted_by_user:users!special_clauses_submitted_by_fkey(full_name), decided_by_user:users!special_clauses_decided_by_fkey(full_name)")
    .eq(kind === "case" ? "case_id" : "contract_id", id)
    .order("revision", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function submitClause(kind: SubjectKind, id: string, request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const parsed = submitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const d = parsed.data;

  const result = await submitSpecialClause(createAdminClient(), {
    subject: { kind, id }, actor: auth.actor, intent: d.intent, reason: d.reason,
    clauseText: d.clause_text, reviewToken: d.review_token, report: d.report,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: { revision_id: result.revisionId, status: result.status } });
}

export async function decideClause(kind: SubjectKind, id: string, request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const d = parsed.data;

  const result = await decideSpecialClause(createAdminClient(), {
    subject: { kind, id }, revisionId: d.revision_id, actor: auth.actor,
    decision: d.decision, note: d.note, requiredChanges: d.required_changes,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: { status: result.status } });
}

export async function withdrawClause(kind: SubjectKind, id: string) {
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const result = await withdrawSpecialClause(createAdminClient(), { subject: { kind, id }, actor: auth.actor });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: { ok: true } });
}

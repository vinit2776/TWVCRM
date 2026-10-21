import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { submitSpecialClause } from "@/lib/special-clause/service";
import { requireActor } from "@/lib/special-clause/route-helpers";

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

// GET: every revision with who decided it — the history behind the contract card.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const { data, error } = await supabase
    .from("special_clauses")
    .select("*, submitted_by_user:users!special_clauses_submitted_by_fkey(full_name), decided_by_user:users!special_clauses_decided_by_fkey(full_name)")
    .eq("contract_id", id)
    .order("revision", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

// POST: submit a new revision (auto-approved when the author is a manager/admin).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const parsed = submitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const d = parsed.data;

  const result = await submitSpecialClause(createAdminClient(), {
    contractId: id, actor: auth.actor, intent: d.intent, reason: d.reason,
    clauseText: d.clause_text, reviewToken: d.review_token, report: d.report,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: { revision_id: result.revisionId, status: result.status } });
}

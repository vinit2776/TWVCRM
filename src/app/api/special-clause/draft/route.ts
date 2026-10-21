import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { draftSpecialClause, SpecialClauseAiError } from "@/lib/special-clause/ai";
import { issueReviewToken } from "@/lib/special-clause/token";
import { canAuthorSpecialClause } from "@/lib/special-clause/gate";
import { MEMBERSHIP_SPECIAL_CLAUSE_NUMBER, MEMBERSHIP_FIXED_CLAUSE_TOPICS, VIRTUAL_OFFICE_FIXED_CLAUSE_TOPICS } from "@/lib/special-clause/membership";
import { requireActor } from "@/lib/special-clause/route-helpers";

// Stateless: drafts and vets a clause, writes nothing and contacts no customer.
const schema = z.object({
  // Which agreement family the clause is for; defaults to the coworking membership agreement.
  kind: z.enum(["membership", "virtual_office"]).default("membership"),
  intent: z.string().trim().min(10, "Describe what was agreed in a sentence or two").max(1500),
  reason: z.string().trim().min(10, "Say why this is needed").max(1500),
  facts: z.record(z.string().max(60), z.string().max(300)).refine((f) => Object.keys(f).length <= 20, "Too many facts").default({}),
  feedback: z.string().trim().max(2000).optional(),
  // The author skipped Claude's questions: gaps are filled and every addition is disclosed to the approver.
  relaxed: z.boolean().default(false),
  previous_text: z.string().trim().max(4000).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;
  if (!canAuthorSpecialClause(auth.actor.role)) {
    return NextResponse.json({ error: "You can't add a special clause." }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const d = parsed.data;

  try {
    const result = await draftSpecialClause({
      intent: d.intent,
      reason: d.reason,
      feedback: d.feedback,
      previousText: d.previous_text,
      relaxed: d.relaxed,
      context: d.kind === "virtual_office"
        ? { clauseNumber: null, facts: d.facts, fixedClauseTopics: VIRTUAL_OFFICE_FIXED_CLAUSE_TOPICS }
        : { clauseNumber: MEMBERSHIP_SPECIAL_CLAUSE_NUMBER, facts: d.facts, fixedClauseTopics: MEMBERSHIP_FIXED_CLAUSE_TOPICS },
    });
    if (result.status === "drafted") {
      return NextResponse.json({ ...result, review_token: issueReviewToken(result.clause_text, d.intent) });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SpecialClauseAiError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}

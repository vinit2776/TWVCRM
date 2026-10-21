import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { decideSpecialClause } from "@/lib/special-clause/service";
import { requireActor } from "@/lib/special-clause/route-helpers";

const schema = z.object({
  revision_id: z.string().uuid(),
  decision: z.enum(["approve", "request_changes"]),
  note: z.string().max(2000).optional(),
  required_changes: z.string().max(2000).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const d = parsed.data;

  const result = await decideSpecialClause(createAdminClient(), {
    contractId: id, revisionId: d.revision_id, actor: auth.actor,
    decision: d.decision, note: d.note, requiredChanges: d.required_changes,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: { status: result.status } });
}

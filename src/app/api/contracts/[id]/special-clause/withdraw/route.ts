import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { withdrawSpecialClause } from "@/lib/special-clause/service";
import { requireActor } from "@/lib/special-clause/route-helpers";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireActor(supabase);
  if ("response" in auth) return auth.response;

  const result = await withdrawSpecialClause(createAdminClient(), { contractId: id, actor: auth.actor });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: { ok: true } });
}

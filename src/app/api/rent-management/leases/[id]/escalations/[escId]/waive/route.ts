import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const waiveSchema = z.object({ notes: z.string().nullish() });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; escId: string }> }
) {
  const { escId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin")
    return NextResponse.json({ error: "Only admin can waive escalations" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const parsed = waiveSchema.safeParse(body);

  const { data: escalation } = await supabase.from("lease_escalations").select("status").eq("id", escId).single();
  if (!escalation) return NextResponse.json({ error: "Escalation not found" }, { status: 404 });
  if (escalation.status !== "scheduled")
    return NextResponse.json({ error: "Only scheduled escalations can be waived" }, { status: 409 });

  const { data, error } = await supabase
    .from("lease_escalations")
    .update({ status: "waived", applied_by: dbUser.id, applied_at: new Date().toISOString(), notes: parsed.success ? parsed.data.notes : null })
    .eq("id", escId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_escalation", entityId: escId, action: "update", performedBy: dbUser.id });
  return NextResponse.json({ data });
}

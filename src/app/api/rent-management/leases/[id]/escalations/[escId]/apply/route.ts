import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; escId: string }> }
) {
  const { id, escId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin")
    return NextResponse.json({ error: "Only admin can apply escalations" }, { status: 403 });

  const { data: escalation } = await supabase
    .from("lease_escalations")
    .select("*")
    .eq("id", escId)
    .eq("lease_id", id)
    .single();

  if (!escalation) return NextResponse.json({ error: "Escalation not found" }, { status: 404 });
  if (escalation.status !== "scheduled")
    return NextResponse.json({ error: "Only scheduled escalations can be applied" }, { status: 409 });

  // Update lease base rent
  const { error: leaseErr } = await supabase
    .from("property_leases")
    .update({ base_rent_amount: escalation.new_amount })
    .eq("id", id);

  if (leaseErr) return NextResponse.json({ error: leaseErr.message }, { status: 500 });

  // Mark escalation as applied
  const { data, error } = await supabase
    .from("lease_escalations")
    .update({ status: "applied", applied_by: dbUser.id, applied_at: new Date().toISOString() })
    .eq("id", escId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_escalation", entityId: escId, action: "update", performedBy: dbUser.id, changes: { status: { old: "scheduled", new: "applied" } } });
  return NextResponse.json({ data });
}

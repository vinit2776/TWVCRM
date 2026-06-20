import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const OUTCOMES = ["converted", "not_interested", "no_response"] as const;
type Outcome = (typeof OUTCOMES)[number];

// POST /api/leads/[id]/resolve
// Marks the enquiry as resolved with an outcome. Removes it from the active
// queue but keeps it in the enquiry log for campaign attribution.
// Body: { outcome: "converted" | "not_interested" | "no_response" }
//       Pass { outcome: null } to un-resolve (admin reopen).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { outcome?: Outcome | null };

  if (body.outcome !== null && !OUTCOMES.includes(body.outcome as Outcome)) {
    return NextResponse.json(
      { error: `outcome must be one of ${OUTCOMES.join(", ")} or null` },
      { status: 400 }
    );
  }

  const reopen = body.outcome === null;

  if (reopen && dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admin can reopen a resolved enquiry" },
      { status: 403 }
    );
  }

  const { data: oldLead } = await supabase
    .from("leads")
    .select("resolved_at, resolved_by, resolution_outcome")
    .eq("id", id)
    .single();

  if (!oldLead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const updateData = reopen
    ? { resolved_at: null, resolved_by: null, resolution_outcome: null }
    : {
        resolved_at: new Date().toISOString(),
        resolved_by: dbUser.id,
        resolution_outcome: body.outcome as Outcome,
      };

  const { data, error } = await supabase
    .from("leads")
    .update(updateData)
    .eq("id", id)
    .select("id, resolved_at, resolved_by, resolution_outcome")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "lead",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      resolved_at:        { old: oldLead.resolved_at,        new: updateData.resolved_at },
      resolution_outcome: { old: oldLead.resolution_outcome, new: updateData.resolution_outcome },
    },
  });

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// 'superseded' is written only by the 00584 backfill, never through the API.
const OUTCOMES = ["converted", "not_interested", "no_response"] as const;
type Outcome = (typeof OUTCOMES)[number];

// POST /api/enquiries/[id]/resolve
// Marks one enquiry resolved with an outcome. Removes it from the active queue but keeps it
// in the enquiry log for campaign attribution.
// Body: { outcome: "converted" | "not_interested" | "no_response" }
//       Pass { outcome: null } to reopen (admin only).
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

  // lead_enquiries is read-only to users under RLS (no blanket UPDATE policy, so nobody can
  // edit a reference); this route is the one place that writes claim/resolve state.
  const admin = await createAdminClient();

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

  const { data: old } = await admin
    .from("lead_enquiries")
    .select("reference, lead_id, resolved_at, resolution_outcome")
    .eq("id", id)
    .single();

  if (!old) {
    return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  }

  const updateData = reopen
    ? { resolved_at: null, resolved_by: null, resolution_outcome: null }
    : {
        resolved_at: new Date().toISOString(),
        resolved_by: dbUser.id,
        resolution_outcome: body.outcome as Outcome,
      };

  const { data, error } = await admin
    .from("lead_enquiries")
    .update(updateData)
    .eq("id", id)
    .select("id, reference, resolved_at, resolved_by, resolution_outcome")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (old.lead_id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: old.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        enquiry: { old: old.reference, new: old.reference },
        resolved_at: { old: old.resolved_at, new: updateData.resolved_at },
        resolution_outcome: { old: old.resolution_outcome, new: updateData.resolution_outcome },
      },
    });
  }

  return NextResponse.json({ data });
}

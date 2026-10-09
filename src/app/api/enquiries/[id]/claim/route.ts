import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// POST /api/enquiries/[id]/claim
// Soft claim of one enquiry — any authenticated user can claim or release. Last claimer wins.
// Body: { claimed?: boolean }  (default true)
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
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 403 });
  }

  // lead_enquiries is read-only to users under RLS (no blanket UPDATE policy, so nobody can
  // edit a reference); this route is the one place that writes claim/resolve state.
  const admin = await createAdminClient();

  const body = (await request.json().catch(() => ({}))) as { claimed?: boolean };
  const claimed = body.claimed !== false;

  const { data: old } = await admin
    .from("lead_enquiries")
    .select("reference, lead_id, claimed_by, claimed_at, resolved_at")
    .eq("id", id)
    .single();

  if (!old) {
    return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  }
  if (old.resolved_at) {
    return NextResponse.json({ error: "This enquiry is already resolved" }, { status: 409 });
  }

  const updateData = claimed
    ? { claimed_by: dbUser.id, claimed_at: new Date().toISOString() }
    : { claimed_by: null, claimed_at: null };

  const { data, error } = await admin
    .from("lead_enquiries")
    .update(updateData)
    .eq("id", id)
    .select(
      "id, reference, claimed_by, claimed_at, claimer:users!lead_enquiries_claimed_by_fkey(id, full_name)"
    )
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
        claimed_by: { old: old.claimed_by, new: updateData.claimed_by },
        claimed_at: { old: old.claimed_at, new: updateData.claimed_at },
      },
    });
  }

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// POST /api/leads/[id]/claim
// Soft claim — any authenticated user can claim or unclaim. Last claimer wins.
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

  const body = (await request.json().catch(() => ({}))) as { claimed?: boolean };
  const claimed = body.claimed !== false;

  const { data: oldLead } = await supabase
    .from("leads")
    .select("claimed_by, claimed_at")
    .eq("id", id)
    .single();

  if (!oldLead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const updateData = claimed
    ? { claimed_by: dbUser.id, claimed_at: new Date().toISOString() }
    : { claimed_by: null, claimed_at: null };

  const { data, error } = await supabase
    .from("leads")
    .update(updateData)
    .eq("id", id)
    .select("id, claimed_by, claimed_at, claimer:users!leads_claimed_by_fkey(id, full_name)")
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
      claimed_by: { old: oldLead.claimed_by, new: updateData.claimed_by },
      claimed_at: { old: oldLead.claimed_at, new: updateData.claimed_at },
    },
  });

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  if (body.status) allowedFields.status = body.status;
  if (body.sent_at) allowedFields.sent_at = body.sent_at;
  if (body.viewed_at) allowedFields.viewed_at = body.viewed_at;
  if (body.accepted_at) allowedFields.accepted_at = body.accepted_at;
  if (body.rejected_at) allowedFields.rejected_at = body.rejected_at;

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data: oldProposal } = await supabase.from("proposals").select("*").eq("id", id).single();

  const { data, error } = await supabase
    .from("proposals")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldProposal) {
    logAudit(supabase, {
      entityType: "proposal",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldProposal as Record<string, unknown>, allowedFields),
    });
  }

  return NextResponse.json({ data });
}

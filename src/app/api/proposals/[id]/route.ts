import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges, logView } from "@/lib/audit";

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
    .select("*, lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, location_id, entity_type, billing_emails), location:locations!proposals_location_id_fkey(id, name, code, proposal_amenity_icons), deposit_payment_recorded_by_user:users!proposals_deposit_payment_recorded_by_fkey(id, full_name)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    await logView(supabase, { entityType: "proposal", entityId: id, performedBy: dbUser.id });
  }

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
  if (body.location_id !== undefined) allowedFields.location_id = body.location_id || null;
  if (body.sent_at) allowedFields.sent_at = body.sent_at;
  if (body.viewed_at) allowedFields.viewed_at = body.viewed_at;
  if (body.accepted_at) allowedFields.accepted_at = body.accepted_at;
  if (body.rejected_at) allowedFields.rejected_at = body.rejected_at;
  if (body.rejection_reason !== undefined) allowedFields.rejection_reason = body.rejection_reason || null;
  // Allow clearing razorpay links for regeneration
  if (body.razorpay_payment_link_id !== undefined) allowedFields.razorpay_payment_link_id = body.razorpay_payment_link_id;
  if (body.razorpay_payment_link_url !== undefined) allowedFields.razorpay_payment_link_url = body.razorpay_payment_link_url;
  if (body.deposit_razorpay_link_id !== undefined) allowedFields.deposit_razorpay_link_id = body.deposit_razorpay_link_id;
  if (body.deposit_razorpay_link_url !== undefined) allowedFields.deposit_razorpay_link_url = body.deposit_razorpay_link_url;
  if (body.occupation_start_date !== undefined) allowedFields.occupation_start_date = body.occupation_start_date;

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

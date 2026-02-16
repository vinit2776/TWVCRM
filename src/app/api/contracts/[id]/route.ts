import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
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
    .from("contracts")
    .select("*, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile), proposal:proposals!contracts_proposal_id_fkey(proposal_number, title), signed_document:documents!contracts_signed_document_id_fkey(id, title, file_name, file_path, mime_type, size_bytes, created_at)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

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
  if (body.notes !== undefined) allowedFields.notes = body.notes;
  if (body.termination_reason) allowedFields.termination_reason = body.termination_reason;
  if (body.next_billing_date) allowedFields.next_billing_date = body.next_billing_date;
  if (body.end_date) allowedFields.end_date = body.end_date;
  if (body.tenure_months) allowedFields.tenure_months = body.tenure_months;
  if (body.renewed_at) allowedFields.renewed_at = body.renewed_at;
  if (body.signed_document_id !== undefined) allowedFields.signed_document_id = body.signed_document_id;

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data: oldContract } = await supabase.from("contracts").select("*").eq("id", id).single();
  if (!oldContract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  // Handle special status transitions
  if (body.status && body.status !== oldContract.status) {
    if (body.status === "active") {
      allowedFields.activated_at = new Date().toISOString();
    } else if (body.status === "terminated") {
      if (!body.termination_reason && !allowedFields.termination_reason) {
        return NextResponse.json({ error: "Termination reason is required" }, { status: 400 });
      }
      allowedFields.terminated_at = new Date().toISOString();
    } else if (body.status === "renewed") {
      allowedFields.renewed_at = new Date().toISOString();
    }
  }

  const { data, error } = await supabase
    .from("contracts")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldContract) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldContract as Record<string, unknown>, allowedFields),
    });
  }

  // Auto-advance lead status when contract becomes active
  if (body.status === "active" && oldContract.status !== "active") {
    await autoUpdateLeadStatus(supabase, oldContract.lead_id, "contract");
  }

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only allow deletion of draft contracts
  const { data: contract } = await supabase.from("contracts").select("*").eq("id", id).single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (contract.status !== "draft") {
    return NextResponse.json({ error: "Only draft contracts can be deleted" }, { status: 400 });
  }

  const { error } = await supabase.from("contracts").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
      changes: { record: { old: contract, new: null } },
    });
  }

  return NextResponse.json({ message: "Contract deleted" });
}

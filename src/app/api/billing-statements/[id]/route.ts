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

  const { data: statement, error } = await supabase
    .from("billing_statements")
    .select(
      "*, contract:contracts!billing_statements_contract_id_fkey(id, contract_number, title), booking:bookings!billing_statements_booking_id_fkey(id, booking_number, booking_date, guest_name), lead:leads!billing_statements_lead_id_fkey(id, first_name, last_name, company)"
    )
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!statement) return NextResponse.json({ error: "Billing statement not found" }, { status: 404 });

  // Fetch associated usage charges
  const { data: usageCharges } = await supabase
    .from("usage_charges")
    .select("*")
    .eq("billing_statement_id", id)
    .order("charge_date", { ascending: true });

  return NextResponse.json({ data: { ...statement, usage_charges: usageCharges || [] } });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch old statement for diff and status validation
  const { data: oldStatement } = await supabase
    .from("billing_statements")
    .select("*")
    .eq("id", id)
    .single();

  if (!oldStatement) return NextResponse.json({ error: "Billing statement not found" }, { status: 404 });

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  // Handle status transitions
  if (body.status !== undefined) {
    const currentStatus = oldStatement.status;
    const newStatus = body.status;

    if (currentStatus === "draft" && newStatus === "finalized") {
      allowedFields.status = "finalized";
      allowedFields.finalized_at = new Date().toISOString();
    } else if (currentStatus === "finalized" && newStatus === "exported") {
      allowedFields.status = "exported";
      allowedFields.exported_at = new Date().toISOString();
    } else {
      return NextResponse.json(
        { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` },
        { status: 400 }
      );
    }
  }

  // Allow updating notes
  if (body.notes !== undefined) allowedFields.notes = body.notes;

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("billing_statements")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldStatement) {
    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldStatement as Record<string, unknown>, allowedFields),
    });
  }

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { messaging } from "@/lib/whatsapp";

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

  // Fetch facility usage records for this statement's accounting period.
  // These are service overages (e.g. conference room hours beyond free quota)
  // stored in facility_usage_records and rolled into the statement's usage_amount
  // at billing time. We surface them here as named line items so the statement
  // view can render them individually rather than as an opaque lump sum.
  let facilityCharges: Array<{
    id: string;
    name: string;
    unit: string;
    quantity_used: number;
    free_quota_applied: number;
    billable_quantity: number;
    unit_price: number;
    total_charge: number;
  }> = [];

  if (statement.accounting_period_id && statement.contract_id) {
    const { data: facRecords } = await supabase
      .from("facility_usage_records")
      .select(`
        id,
        quantity_used,
        free_quota_applied,
        billable_quantity,
        unit_price,
        total_charge,
        contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(name, unit)
      `)
      .eq("accounting_period_id", statement.accounting_period_id)
      .eq("contract_id", statement.contract_id)
      .gt("total_charge", 0)
      .order("created_at", { ascending: true });

    facilityCharges = (facRecords || []).map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fac = r.contract_facility as any;
      return {
        id: r.id as string,
        name: fac?.name || "Facility usage",
        unit: fac?.unit || "unit",
        quantity_used: Number(r.quantity_used || 0),
        free_quota_applied: Number(r.free_quota_applied || 0),
        billable_quantity: Number(r.billable_quantity || 0),
        unit_price: Number(r.unit_price || 0),
        total_charge: Number(r.total_charge || 0),
      };
    });
  }

  return NextResponse.json({
    data: {
      ...statement,
      usage_charges: usageCharges || [],
      facility_charges: facilityCharges,
    },
  });
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

  // WhatsApp/SMS notification when statement is finalized — fire-and-forget
  if (body.status === "finalized" && oldStatement.lead_id && data) {
    (async () => {
      const { data: lead } = await supabase
        .from("leads")
        .select("first_name, last_name, company, phone, mobile")
        .eq("id", oldStatement.lead_id)
        .single();

      const phone = (lead?.mobile || lead?.phone) as string | null | undefined;
      if (lead && phone && body.send_sms !== false) {
        const customerName = lead.company
          ?? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
        const amount = `₹${((data.total_amount as number) ?? 0).toLocaleString("en-IN")}`;
        messaging.billingStatementReady(
          phone,
          customerName,
          (data.statement_number as string) ?? id.slice(0, 8),
          amount,
          id
        ).catch(console.error);
      }
    })();
  }

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

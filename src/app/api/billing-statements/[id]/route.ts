import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { messaging } from "@/lib/whatsapp";

export const maxDuration = 30;

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

  // Fetch service usage records for this statement (if any linked)
  let serviceCharges: Array<{
    id: string;
    service_name: string;
    quantity_used: number;
    quota: number;
    overage: number;
    rate: number;
    amount: number;
  }> = [];

  if (statement.contract_id) {
    const periodStart = new Date(statement.period_start);
    const pYear = periodStart.getFullYear();
    const pMonth = periodStart.getMonth() + 1;

    const { data: svcRecords } = await supabase
      .from("service_usage_records")
      .select(`
        id, quantity_used, quota_snapshot, overage_quantity, overage_rate_snapshot, amount,
        service:service_catalog!service_usage_records_service_id_fkey(name)
      `)
      .eq("contract_id", statement.contract_id)
      .eq("period_year", pYear)
      .eq("period_month", pMonth)
      .eq("billing_statement_id", id);

    serviceCharges = (svcRecords || []).map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = r.service as any;
      return {
        id: r.id as string,
        service_name: (Array.isArray(svc) ? svc[0]?.name : svc?.name) || "Service",
        quantity_used: Number(r.quantity_used || 0),
        quota: Number(r.quota_snapshot || 0),
        overage: Number(r.overage_quantity || 0),
        rate: Number(r.overage_rate_snapshot || 0),
        amount: Number(r.amount || 0),
      };
    });
  }

  // Fetch auto-rolled booking line items (bookings done in this period under the contract)
  let bookingCharges: Array<{
    id: string;
    booking_number: string;
    date: string;
    space: string;
    time: string;
    duration: string;
    amount: number;
    is_free: boolean;
  }> = [];

  if (statement.contract_id && statement.line_items) {
    // Pull from line_items JSONB if available (already structured)
    const sections = statement.line_items as Array<{ type: string; items: Record<string, unknown>[] }>;
    const bookingSec = sections.find((s) => s.type === "booking_usage");
    if (bookingSec) {
      bookingCharges = bookingSec.items.map((item) => ({
        id: String(item.booking_id || ""),
        booking_number: String(item.booking_number || ""),
        date: String(item.date || ""),
        space: String(item.space || ""),
        time: String(item.time || ""),
        duration: String(item.duration || ""),
        amount: Number(item.amount || 0),
        is_free: item.note === "Free quota",
      }));
    }
  }

  return NextResponse.json({
    data: {
      ...statement,
      usage_charges: usageCharges || [],
      facility_charges: facilityCharges,
      service_charges: serviceCharges,
      booking_charges: bookingCharges,
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

  // Resolve the calling user's DB id (needed for actor columns)
  const { data: dbUserEarly } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();

  // Handle status transitions
  if (body.status !== undefined) {
    const currentStatus = oldStatement.status;
    const newStatus = body.status;

    if (currentStatus === "draft" && newStatus === "finalized") {
      allowedFields.status = "finalized";
      allowedFields.finalized_at = new Date().toISOString();
      if (dbUserEarly?.id) allowedFields.finalized_by = dbUserEarly.id;
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

  // Mark as accounted — admin/manager/accounts only
  if (body.accounted === true) {
    if (!dbUserEarly || !["admin", "manager", "accounts"].includes(dbUserEarly.role)) {
      return NextResponse.json({ error: "Only admin, manager, or accounts can mark as accounted" }, { status: 403 });
    }
    if (!oldStatement.gst_invoice_number) {
      return NextResponse.json({ error: "GST invoice must be generated before marking as accounted" }, { status: 400 });
    }
    allowedFields.accounted = true;
    allowedFields.accounted_at = new Date().toISOString();
    allowedFields.accounted_by = dbUserEarly.id;
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

  if (dbUserEarly?.id && oldStatement) {
    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: id,
      action: "update",
      performedBy: dbUserEarly.id,
      changes: diffChanges(oldStatement as Record<string, unknown>, allowedFields),
    });
  }

  return NextResponse.json({ data });
}

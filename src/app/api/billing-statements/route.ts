import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateBillingStatementSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

const SELECT_FIELDS =
  "*, contract:contracts!billing_statements_contract_id_fkey(id, contract_number, title), booking:bookings!billing_statements_booking_id_fkey(id, booking_number, booking_date, guest_name), lead:leads!billing_statements_lead_id_fkey(id, first_name, last_name, company)";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const contractId = searchParams.get("contract_id");
  const bookingId = searchParams.get("booking_id");
  const leadId = searchParams.get("lead_id");
  const status = searchParams.get("status");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("billing_statements")
    .select(SELECT_FIELDS, { count: "exact" });

  if (contractId) query = query.eq("contract_id", contractId);
  if (bookingId) query = query.eq("booking_id", bookingId);
  if (leadId) query = query.eq("lead_id", leadId);
  if (status) query = query.eq("status", status);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = generateBillingStatementSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  let fixedAmount = 0;
  let taxPercentage = 0;
  let leadId: string | null = null;

  if (result.data.contract_id) {
    // Contract-based statement
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("id, lead_id, total_amount, tax_percentage")
      .eq("id", result.data.contract_id)
      .single();

    if (contractError || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    fixedAmount = contract.total_amount || 0;
    taxPercentage = contract.tax_percentage || 0;
    leadId = contract.lead_id;
  } else if (result.data.booking_id) {
    // Booking-based statement
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, lead_id, total_amount, tax_percentage")
      .eq("id", result.data.booking_id)
      .single();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    fixedAmount = booking.total_amount || 0;
    taxPercentage = booking.tax_percentage || 0;
    leadId = booking.lead_id ?? null;
  }

  // Fetch all pending usage charges for this contract or booking within the billing period
  let usageQuery = supabase
    .from("usage_charges")
    .select("id, total")
    .gte("charge_date", result.data.period_start)
    .lte("charge_date", result.data.period_end)
    .eq("status", "pending");

  if (result.data.contract_id) {
    usageQuery = usageQuery.eq("contract_id", result.data.contract_id);
  } else if (result.data.booking_id) {
    usageQuery = usageQuery.eq("booking_id", result.data.booking_id);
  }

  const { data: usageCharges, error: usageError } = await usageQuery;
  if (usageError) return NextResponse.json({ error: usageError.message }, { status: 500 });

  // Calculate totals
  const usageAmount = (usageCharges || []).reduce((sum, charge) => sum + (charge.total || 0), 0);
  const subtotal = fixedAmount + usageAmount;
  const taxAmount = subtotal * (taxPercentage / 100);
  const totalAmount = subtotal + taxAmount;

  // Idempotency guard — prevent duplicate statements for the same contract/booking + period
  if (result.data.contract_id || result.data.booking_id) {
    let dupQuery = supabase
      .from("billing_statements")
      .select("id, statement_number, status")
      .eq("period_start", result.data.period_start)
      .neq("status", "voided");

    if (result.data.contract_id) {
      dupQuery = dupQuery.eq("contract_id", result.data.contract_id);
    } else if (result.data.booking_id) {
      dupQuery = dupQuery.eq("booking_id", result.data.booking_id);
    }

    const { data: existing } = await dupQuery.maybeSingle();
    if (existing) {
      return NextResponse.json(
        {
          error: "A billing statement already exists for this period",
          existing_id: existing.id,
          existing_number: existing.statement_number,
          existing_status: existing.status,
        },
        { status: 409 }
      );
    }
  }

  // Insert billing statement (statement_number is auto-generated by DB trigger)
  const { data: statement, error: insertError } = await supabase
    .from("billing_statements")
    .insert({
      contract_id: result.data.contract_id ?? null,
      booking_id: result.data.booking_id ?? null,
      lead_id: leadId,
      period_start: result.data.period_start,
      period_end: result.data.period_end,
      fixed_amount: fixedAmount,
      usage_amount: usageAmount,
      subtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      status: "draft",
      notes: result.data.notes,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  // Update all fetched usage charges: set status → "billed" and link to this statement
  if (usageCharges && usageCharges.length > 0) {
    const chargeIds = usageCharges.map((c) => c.id);
    const { error: updateError } = await supabase
      .from("usage_charges")
      .update({ status: "billed", billing_statement_id: statement.id })
      .in("id", chargeIds);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  if (statement && dbUser?.id) {
    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: statement.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: statement } },
    });
  }

  return NextResponse.json({ data: statement }, { status: 201 });
}

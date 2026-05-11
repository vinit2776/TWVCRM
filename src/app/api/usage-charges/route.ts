import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createUsageChargeSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

const CHARGE_ALLOWED_ROLES = ["admin", "manager", "accounts"];

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
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("usage_charges")
    .select(
      "*, contract:contracts!usage_charges_contract_id_fkey(id, contract_number, billing_cycle), booking:bookings!usage_charges_booking_id_fkey(id, booking_number, booking_date, lead_id, guest_name, guest_email), lead:leads!usage_charges_lead_id_fkey(id, first_name, last_name, company)",
      { count: "exact" }
    );

  if (contractId) query = query.eq("contract_id", contractId);
  if (bookingId) query = query.eq("booking_id", bookingId);
  if (leadId) query = query.eq("lead_id", leadId);
  if (status) query = query.eq("status", status);
  if (dateFrom) query = query.gte("charge_date", dateFrom);
  if (dateTo) query = query.lte("charge_date", dateTo);

  query = query.order("charge_date", { ascending: false }).range(offset, offset + limit - 1);

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
  const result = createUsageChargeSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();

  if (!dbUser || !CHARGE_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin, manager, or accounts can create usage charges" },
      { status: 403 }
    );
  }

  let leadId: string | null = null;

  // Derive the billing period from charge_date for lock/finalization checks
  const chargeDate = new Date(result.data.charge_date + "T00:00:00");
  const chargeMonth = chargeDate.getMonth() + 1;
  const chargeYear = chargeDate.getFullYear();
  const periodFirst = `${chargeYear}-${String(chargeMonth).padStart(2, "0")}-01`;
  const periodLast = `${chargeYear}-${String(chargeMonth).padStart(2, "0")}-${new Date(chargeYear, chargeMonth, 0).getDate()}`;

  // Check if the accounting period is locked
  const { data: period } = await supabase
    .from("accounting_periods")
    .select("id, status")
    .eq("year", chargeYear)
    .eq("month", chargeMonth)
    .maybeSingle();

  if (period?.status === "locked") {
    const monthLabel = chargeDate.toLocaleString("en-IN", { month: "long", year: "numeric" });
    return NextResponse.json(
      { error: `The ${monthLabel} billing period is locked. Charges cannot be added to a locked period.` },
      { status: 400 },
    );
  }

  // Will hold the contract's tax_percentage when creating a contract-based
  // charge — used below to override the client-supplied gst_rate so per-charge
  // GST always matches the statement-level rate.
  let contractTaxPercentage: number | null = null;

  if (result.data.contract_id) {
    // Contract-based charge — must exist and be active
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("id, lead_id, status, tax_percentage")
      .eq("id", result.data.contract_id)
      .single();

    if (contractError || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }
    if (contract.status !== "active") {
      return NextResponse.json({ error: "Contract is not active" }, { status: 400 });
    }

    // Check if a finalized/exported statement already exists for this contract+period
    const { data: existingStatement } = await supabase
      .from("billing_statements")
      .select("id, status, statement_number")
      .eq("contract_id", result.data.contract_id)
      .gte("period_start", periodFirst)
      .lte("period_start", periodLast)
      .in("status", ["finalized", "exported"])
      .maybeSingle();

    if (existingStatement) {
      const monthLabel = chargeDate.toLocaleString("en-IN", { month: "long", year: "numeric" });
      return NextResponse.json(
        { error: `The ${monthLabel} bill (${existingStatement.statement_number}) is already finalized. Charges cannot be added to a finalized bill.` },
        { status: 400 },
      );
    }

    leadId = contract.lead_id;
    contractTaxPercentage = contract.tax_percentage != null ? Number(contract.tax_percentage) : null;
  } else if (result.data.booking_id) {
    // Booking-based charge — booking must exist
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, lead_id, status")
      .eq("id", result.data.booking_id)
      .single();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    leadId = booking.lead_id ?? null;
  }

  // GST: server is the source of truth for the computed fields.
  // For contract-based charges, force gst_rate to match the contract's
  // tax_percentage so every line item on the billing statement uses the
  // same rate. This prevents the mismatch where a charge is stored at 5%
  // but the statement-level total applies 18%. For non-contract charges
  // (booking-based), the client-supplied rate (default 18%) is used.
  const gstRate = contractTaxPercentage ?? result.data.gst_rate ?? 18;
  const subtotal = Number(result.data.total);
  const gstAmount = parseFloat((subtotal * gstRate / 100).toFixed(2));
  const totalWithGst = parseFloat((subtotal + gstAmount).toFixed(2));

  const { data, error } = await supabase
    .from("usage_charges")
    .insert({
      contract_id: result.data.contract_id ?? null,
      booking_id: result.data.booking_id ?? null,
      description: result.data.description,
      quantity: result.data.quantity,
      unit_price: result.data.unit_price,
      total: subtotal,
      gst_rate: gstRate,
      gst_amount: gstAmount,
      total_with_gst: totalWithGst,
      charge_date: result.data.charge_date,
      notes: result.data.notes,
      proof_path: body.proof_path || null,
      lead_id: leadId,
      status: "pending",
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  return NextResponse.json({ data }, { status: 201 });
}

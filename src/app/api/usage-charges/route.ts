import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createUsageChargeSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

// POST (create): admin, manager, accounts, floor_manager, sales_rep.
// No DELETE handler exists — once created, charges can only be voided/removed
// by admin via statement management. This is intentional: floor managers can
// submit charges but cannot remove them.
const CHARGE_ALLOWED_ROLES = ["admin", "manager", "accounts", "floor_manager", "sales_rep"];

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
      { error: "You do not have permission to create usage charges" },
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

  // Defaults to the client-supplied values; overwritten below when
  // contract_facility_id is set, since quota math is server-authoritative.
  let facilityQuantity  = result.data.quantity;
  let facilityUnitPrice = result.data.unit_price;
  let facilityTotal     = Number(result.data.total);
  let facilityStatus    = "pending";

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

    // ── Facility-linked charge: quota is authoritative server-side ──────────
    // The client may pre-fill/override description + rate from the facility's
    // config, but quantity/total are always recomputed here against
    // free_quota + prior consumption this month — mirrors the booking-side
    // quota logic in /api/bookings (contractFacilityForQuota).
    if (result.data.contract_facility_id) {
      const { data: facility, error: facilityError } = await supabase
        .from("contract_facilities")
        .select("id, contract_id, name, free_quota, cost_per_unit, is_active")
        .eq("id", result.data.contract_facility_id)
        .eq("contract_id", result.data.contract_id)
        .single();

      if (facilityError || !facility) {
        return NextResponse.json({ error: "Facility not found on this contract" }, { status: 404 });
      }

      const { data: existingCharges } = await supabase
        .from("usage_charges")
        .select("quantity")
        .eq("contract_facility_id", facility.id)
        .is("billing_statement_id", null)
        .in("status", ["pending", "waived"])
        .gte("charge_date", periodFirst)
        .lte("charge_date", periodLast);

      const consumed = (existingCharges || []).reduce((sum, c) => sum + Number(c.quantity || 0), 0);
      const freeRemaining = Math.max(0, Number(facility.free_quota) - consumed);
      const requestedQty = Number(result.data.quantity);
      const overageQty = Math.max(0, requestedQty - freeRemaining);
      const rate = Number(result.data.unit_price);

      if (overageQty > 0) {
        facilityQuantity = overageQty;
        facilityUnitPrice = rate;
        facilityTotal = parseFloat((overageQty * rate).toFixed(2));
        facilityStatus = "pending";
      } else {
        facilityQuantity = requestedQty;
        facilityUnitPrice = 0;
        facilityTotal = 0;
        facilityStatus = "waived";
      }
    }
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
  const subtotal = facilityTotal;
  const gstAmount = parseFloat((subtotal * gstRate / 100).toFixed(2));
  const totalWithGst = parseFloat((subtotal + gstAmount).toFixed(2));

  const { data, error } = await supabase
    .from("usage_charges")
    .insert({
      contract_id: result.data.contract_id ?? null,
      booking_id: result.data.booking_id ?? null,
      contract_facility_id: result.data.contract_facility_id ?? null,
      description: result.data.description,
      quantity: facilityQuantity,
      unit_price: facilityUnitPrice,
      total: subtotal,
      gst_rate: gstRate,
      gst_amount: gstAmount,
      total_with_gst: totalWithGst,
      charge_date: result.data.charge_date,
      hsn_sac_code: result.data.hsn_sac_code || "999799",
      notes: result.data.notes,
      proof_path: body.proof_path || null,
      lead_id: leadId,
      status: facilityStatus,
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

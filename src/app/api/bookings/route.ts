import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createBookingSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const spaceId = searchParams.get("space_id");
  const locationId = searchParams.get("location_id");
  const status = searchParams.get("status");
  const customerType = searchParams.get("customer_type");
  const contractId = searchParams.get("contract_id");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const bookingDate = searchParams.get("booking_date");
  const search = searchParams.get("search");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("bookings")
    .select(
      "*, space:spaces!bookings_space_id_fkey(id, name, capacity, hourly_rate), location:locations!bookings_location_id_fkey(id, name, code), contract:contracts!bookings_contract_id_fkey(id, contract_number), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email), facilities:booking_facilities(*)",
      { count: "exact" }
    );

  if (spaceId) query = query.eq("space_id", spaceId);
  if (locationId) query = query.eq("location_id", locationId);
  if (status) query = query.eq("status", status);
  if (customerType) query = query.eq("customer_type", customerType);
  if (contractId) query = query.eq("contract_id", contractId);
  if (bookingDate) query = query.eq("booking_date", bookingDate);
  if (dateFrom) query = query.gte("booking_date", dateFrom);
  if (dateTo) query = query.lte("booking_date", dateTo);
  if (search?.trim()) query = query.ilike("booking_number", `%${search.trim()}%`);

  query = query.order("booking_date", { ascending: false }).order("start_time", { ascending: true }).range(offset, offset + limit - 1);

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

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const result = createBookingSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const input = result.data;

  // 1. Fetch space
  const { data: space, error: spaceErr } = await supabase
    .from("spaces")
    .select("*, facilities:space_facilities(*)")
    .eq("id", input.space_id)
    .single();

  if (spaceErr || !space) return NextResponse.json({ error: "Space not found" }, { status: 404 });
  if (!space.is_active) return NextResponse.json({ error: "Space is not active" }, { status: 400 });

  // 2. Availability check
  const dayOfWeek = DAYS_OF_WEEK[new Date(input.booking_date + "T00:00:00").getDay()];
  const dayHours = space.operating_hours?.[dayOfWeek];
  if (!dayHours || !dayHours.is_open) {
    return NextResponse.json({ error: `Space is closed on ${dayOfWeek}` }, { status: 400 });
  }

  const startMin = timeToMinutes(input.start_time);
  const endMin = timeToMinutes(input.end_time);
  const openMin = timeToMinutes(dayHours.open);
  const closeMin = timeToMinutes(dayHours.close);

  if (startMin < openMin || endMin > closeMin) {
    return NextResponse.json({
      error: `Booking must be within operating hours (${dayHours.open} - ${dayHours.close})`,
    }, { status: 400 });
  }

  const durationMinutes = endMin - startMin;
  if (durationMinutes < space.min_booking_minutes) {
    return NextResponse.json({
      error: `Minimum booking duration is ${space.min_booking_minutes} minutes`,
    }, { status: 400 });
  }

  if (durationMinutes % 30 !== 0) {
    return NextResponse.json({ error: "Duration must be in multiples of 30 minutes" }, { status: 400 });
  }

  // Check advance booking days
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const bookDate = new Date(input.booking_date + "T00:00:00");
  const diffDays = Math.ceil((bookDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays > space.max_advance_booking_days) {
    return NextResponse.json({
      error: `Cannot book more than ${space.max_advance_booking_days} days in advance`,
    }, { status: 400 });
  }

  // Check overlap
  const { data: conflicts } = await supabase
    .from("bookings")
    .select("id, booking_number")
    .eq("space_id", input.space_id)
    .eq("booking_date", input.booking_date)
    .in("status", ["confirmed", "checked_in"])
    .lt("start_time", input.end_time + ":00")
    .gt("end_time", input.start_time + ":00");

  if (conflicts && conflicts.length > 0) {
    return NextResponse.json({
      error: "Time slot conflicts with an existing booking",
    }, { status: 409 });
  }

  // 3. Calculate pricing
  const durationHours = durationMinutes / 60;
  let totalAmount = durationHours * space.hourly_rate;

  // Add facility charges
  const requestedFacilities: { facility_name: string; is_complimentary: boolean; charge: number }[] = [];
  if (input.facility_ids && input.facility_ids.length > 0 && space.facilities) {
    for (const fId of input.facility_ids) {
      const facility = space.facilities.find((f: { id: string }) => f.id === fId);
      if (facility && facility.is_available) {
        const charge = facility.is_complimentary ? 0 : facility.charge_per_use;
        totalAmount += charge;
        requestedFacilities.push({
          facility_name: facility.name,
          is_complimentary: facility.is_complimentary,
          charge,
        });
      }
    }
  }

  // 4. Customer-type-specific logic
  let contractId: string | undefined;
  let leadId: string | undefined;
  let usageChargeId: string | undefined;
  let paymentStatus = "pending";

  if (input.customer_type === "contract_holder" || input.customer_type === "guest") {
    // Fetch contract
    const { data: contract, error: contractErr } = await supabase
      .from("contracts")
      .select("id, lead_id, status")
      .eq("id", input.contract_id!)
      .single();

    if (contractErr || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }
    if (contract.status !== "active") {
      return NextResponse.json({ error: "Contract is not active" }, { status: 400 });
    }

    contractId = contract.id;
    leadId = contract.lead_id;

    // Create usage charge
    const { data: charge, error: chargeErr } = await supabase
      .from("usage_charges")
      .insert({
        contract_id: contract.id,
        lead_id: contract.lead_id,
        description: `Conference Room: ${space.name} (${input.start_time}-${input.end_time}, ${input.booking_date})`,
        quantity: durationHours,
        unit_price: space.hourly_rate,
        total: totalAmount,
        charge_date: input.booking_date,
        status: "pending",
        created_by: dbUser.id,
      })
      .select("id")
      .single();

    if (chargeErr) {
      return NextResponse.json({ error: "Failed to create usage charge: " + chargeErr.message }, { status: 500 });
    }

    usageChargeId = charge?.id;
    paymentStatus = "posted_to_bill";
  }

  if (input.customer_type === "walk_in") {
    leadId = input.lead_id;
    paymentStatus = "pending";
  }

  // For guest type, also set guest details from input
  if (input.customer_type === "guest") {
    // leadId already set from contract above
  }

  // 5. Insert booking
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .insert({
      space_id: input.space_id,
      location_id: space.location_id,
      booking_date: input.booking_date,
      start_time: input.start_time + ":00",
      end_time: input.end_time + ":00",
      duration_hours: durationHours,
      customer_type: input.customer_type,
      contract_id: contractId,
      lead_id: leadId,
      guest_name: input.guest_name,
      guest_email: input.guest_email || null,
      guest_phone: input.guest_phone,
      guest_company: input.guest_company,
      hourly_rate: space.hourly_rate,
      total_amount: totalAmount,
      payment_status: paymentStatus,
      payment_mode: input.payment_mode,
      payment_reference: input.payment_reference,
      usage_charge_id: usageChargeId,
      notes: input.notes,
      created_by: dbUser.id,
    })
    .select("*")
    .single();

  if (bookingErr) {
    return NextResponse.json({ error: bookingErr.message }, { status: 500 });
  }

  // 6. Insert booking facilities
  if (requestedFacilities.length > 0 && booking) {
    await supabase.from("booking_facilities").insert(
      requestedFacilities.map((f) => ({ booking_id: booking.id, ...f }))
    );
  }

  // 7. Issue voucher for walk-in or guest
  if ((input.customer_type === "walk_in" || input.customer_type === "guest") && booking) {
    const { data: voucher } = await supabase
      .from("voucher_repository")
      .select("id, voucher_code")
      .eq("status", "available")
      .eq("validity_days", 1)
      .eq("location_id", space.location_id)
      .limit(1)
      .single();

    if (voucher) {
      // Mark voucher as issued
      await supabase
        .from("voucher_repository")
        .update({
          status: "issued",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("id", voucher.id);

      // Create issuance record
      await supabase
        .from("voucher_issuances")
        .insert({
          contract_id: contractId || null,
          voucher_id: voucher.id,
          lead_id: leadId || null,
          booking_id: booking.id,
          seat_number: 1,
          issued_by: dbUser.id,
          issued_at: new Date().toISOString(),
          valid_from: input.booking_date,
          valid_until: input.booking_date,
          is_active: true,
          seat_occupant_email: input.guest_email || null,
        });
    }
    // Note: If no 1-day voucher is available, we still create the booking
    // The voucher can be issued later from the booking detail page
  }

  // 8. Audit log
  logAudit(supabase, {
    entityType: "booking",
    entityId: booking.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: booking } },
  });

  // 9. Return full booking
  const { data: fullBooking } = await supabase
    .from("bookings")
    .select("*, space:spaces!bookings_space_id_fkey(id, name, capacity, hourly_rate), location:locations!bookings_location_id_fkey(id, name, code), contract:contracts!bookings_contract_id_fkey(id, contract_number), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email), facilities:booking_facilities(*)")
    .eq("id", booking.id)
    .single();

  return NextResponse.json({ data: fullBooking }, { status: 201 });
}

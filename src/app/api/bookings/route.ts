import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createBookingSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { messaging, dltSms } from "@/lib/whatsapp";
import type { SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 30;

const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Find an existing lead by phone or create a new one from booking guest details.
 * Used for walk-in and guest bookings to ensure every customer is tracked as a lead.
 */
async function findOrCreateLeadForBooking(
  supabase: SupabaseClient,
  params: {
    guestName?: string;
    guestEmail?: string;
    guestPhone?: string;
    bookerPhone: string;
    guestCompany?: string;
    guestGstNumber?: string;
    locationId: string;
    createdBy: string;
  }
): Promise<string | null> {
  const searchPhone = params.bookerPhone || params.guestPhone;
  if (!searchPhone) return null;

  // 1. Try to find existing lead by phone/mobile match
  const { data: existingLeads } = await supabase
    .from("leads")
    .select("id, gst_number")
    .or(`phone.eq.${searchPhone},mobile.eq.${searchPhone}`)
    .limit(1);

  if (existingLeads && existingLeads.length > 0) {
    // If a GST number is provided and the lead doesn't have one yet, update it
    if (params.guestGstNumber && !existingLeads[0].gst_number) {
      await supabase
        .from("leads")
        .update({ gst_number: params.guestGstNumber })
        .eq("id", existingLeads[0].id);
    }
    return existingLeads[0].id;
  }

  // 2. Parse guest name into first/last
  let firstName = "Walk-in";
  let lastName = "Customer";
  if (params.guestName?.trim()) {
    const parts = params.guestName.trim().split(/\s+/);
    firstName = parts[0];
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : "—";
  }

  // 3. Create new lead
  const { data: newLead } = await supabase
    .from("leads")
    .insert({
      first_name: firstName,
      last_name: lastName,
      email: params.guestEmail || null,
      phone: params.guestPhone || null,
      mobile: params.bookerPhone,
      company: params.guestCompany || null,
      gst_number: params.guestGstNumber || null,
      location_id: params.locationId,
      source: "direct_walkin",
      status: "new",
      rating: "none",
      score: 0,
      created_by: params.createdBy,
      assigned_to: params.createdBy,
    })
    .select("id")
    .single();

  return newLead?.id || null;
}

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
  const leadId = searchParams.get("lead_id");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const bookingDate = searchParams.get("booking_date");
  const search = searchParams.get("search");

  const includeHistory = searchParams.get("include_history") === "true";
  const offset = (page - 1) * limit;

  // Only compute exact count when the client needs pagination (i.e. the
  // "All Bookings" history section). The dashboard view fetches limit=200
  // with date_from=today and never paginates — skipping the count saves a
  // full table scan on every page load.
  const needsCount = includeHistory || page > 1 || !!status || !!customerType || !!dateFrom || !!dateTo || !!search;

  // Explicit column whitelist — `select("*")` was pulling 50+ booking columns
  // (legacy printer_*, payment tokens, refund metadata, original_*, etc.) on
  // every list request. Listing pages only need ~15 fields. Trims response
  // payload by ~60% and matches what the UI actually renders.
  // Detail page (/bookings/[id]) still uses select("*") for full context.
  const LIST_BOOKING_COLUMNS = [
    "id", "booking_number", "space_id", "location_id", "contract_id", "lead_id",
    "booking_date", "start_time", "end_time", "duration_hours",
    "pricing_model", "unit_rate", "quantity",
    "customer_type", "guest_name", "guest_email", "guest_phone", "guest_company",
    "booker_phone",
    "hourly_rate", "total_amount", "gst_amount", "total_amount_with_gst",
    "payment_status", "payment_mode",
    "status", "check_in_at", "check_out_at",
    "no_show_detected_at", "refund_status",
    "created_at",
  ].join(", ");

  let query = supabase
    .from("bookings")
    .select(
      `${LIST_BOOKING_COLUMNS},` +
      " space:spaces!bookings_space_id_fkey(id, name, capacity, pricing_model, hourly_rate, daily_rate)," +
      " location:locations!bookings_location_id_fkey(id, name, code)," +
      " contract:contracts!bookings_contract_id_fkey(id, contract_number)," +
      " lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email)," +
      " facilities:booking_facilities(id, facility_name, charge)",
      needsCount ? { count: "exact" } : undefined
    );

  if (spaceId) query = query.eq("space_id", spaceId);
  if (locationId) query = query.eq("location_id", locationId);
  if (status) {
    // Support comma-separated statuses, e.g. "checked_out,no_show"
    const parts = status.split(",").map((s) => s.trim()).filter(Boolean);
    query = parts.length > 1 ? query.in("status", parts) : query.eq("status", parts[0]);
  }
  if (customerType) query = query.eq("customer_type", customerType);
  if (contractId) query = query.eq("contract_id", contractId);
  if (leadId) query = query.eq("lead_id", leadId);
  if (bookingDate) query = query.eq("booking_date", bookingDate);
  if (dateFrom) query = query.gte("booking_date", dateFrom);
  if (dateTo) query = query.lte("booking_date", dateTo);
  if (search?.trim()) {
    const s = search.trim();
    // Also search by lead name (pre-query matching lead IDs)
    const { data: matchingLeads } = await supabase
      .from("leads")
      .select("id")
      .or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%`);
    const leadIds = (matchingLeads || []).map((l) => l.id);
    const orClauses = [
      `booking_number.ilike.%${s}%`,
      `booker_phone.ilike.%${s}%`,
      `guest_name.ilike.%${s}%`,
      `guest_phone.ilike.%${s}%`,
      `guest_company.ilike.%${s}%`,
    ];
    if (leadIds.length > 0) orClauses.push(`lead_id.in.(${leadIds.join(",")})`);
    query = query.or(orClauses.join(","));
  }

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

  const body = await request.json();
  const result = createBookingSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const input = result.data;

  // 1. Fetch dbUser + space in parallel (independent queries)
  const [{ data: dbUser }, { data: space, error: spaceErr }] = await Promise.all([
    supabase.from("users").select("id, role").eq("auth_id", user.id).single(),
    supabase.from("spaces").select("*, facilities:space_facilities(*)").eq("id", input.space_id).single(),
  ]);

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });
  if (spaceErr || !space) return NextResponse.json({ error: "Space not found" }, { status: 404 });
  if (!space.is_active) return NextResponse.json({ error: "Space is not active" }, { status: 400 });

  // 2. Availability check
  const dayOfWeek = DAYS_OF_WEEK[new Date(input.booking_date + "T00:00:00").getDay()];
  const dayHours = space.operating_hours?.[dayOfWeek];
  if (!dayHours || !dayHours.is_open) {
    return NextResponse.json({ error: `Space is closed on ${dayOfWeek}` }, { status: 400 });
  }

  // Day-pass spaces (pricing_model = 'daily') always cover the full operating
  // window for that day. Times are auto-set from the centre's operating hours;
  // any input times are ignored to keep behaviour predictable.
  const isDaily = space.pricing_model === "daily";
  const effectiveStart = isDaily ? dayHours.open : input.start_time;
  const effectiveEnd   = isDaily ? dayHours.close : input.end_time;

  if (!effectiveStart || !effectiveEnd) {
    return NextResponse.json({ error: "Start and end times are required for hourly spaces" }, { status: 400 });
  }

  const startMin = timeToMinutes(effectiveStart);
  const endMin   = timeToMinutes(effectiveEnd);
  const openMin  = timeToMinutes(dayHours.open);
  const closeMin = timeToMinutes(dayHours.close);

  if (!isDaily) {
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
    if (durationMinutes % 15 !== 0) {
      return NextResponse.json({ error: "Duration must be in multiples of 15 minutes" }, { status: 400 });
    }
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

  // Overlap check: hourly = strict time overlap; daily = any other booking on that date
  const overlapQuery = supabase
    .from("bookings")
    .select("id, booking_number")
    .eq("space_id", input.space_id)
    .eq("booking_date", input.booking_date)
    .in("status", ["confirmed", "checked_in"]);
  const { data: conflicts } = isDaily
    ? await overlapQuery
    : await overlapQuery
        .lt("start_time", effectiveEnd + ":00")
        .gt("end_time", effectiveStart + ":00");

  // Day-pass: still respect the space's capacity. Conflict only if existing
  // bookings on this date already fill capacity (capacity 1 = single seat).
  if (conflicts && conflicts.length > 0) {
    if (!isDaily || conflicts.length >= (space.capacity ?? 1)) {
      return NextResponse.json({
        error: isDaily
          ? "All day-pass seats are booked for this date"
          : "Time slot conflicts with an existing booking",
      }, { status: 409 });
    }
  }

  // 3. Calculate pricing — branch on pricing_model
  const durationMinutes = endMin - startMin;
  const durationHours = durationMinutes / 60;

  let unitRate: number;
  let quantity: number;
  if (isDaily) {
    if (input.hourly_rate !== undefined && input.hourly_rate >= 0) {
      // The booking form may pass an override (e.g., voucher / promo). Treat as day rate.
      unitRate = input.hourly_rate;
    } else {
      const dr = Number(space.daily_rate ?? 0);
      if (!dr) {
        return NextResponse.json({ error: "Day pass rate not configured for this space" }, { status: 400 });
      }
      unitRate = dr;
    }
    quantity = Math.max(1, Number(input.num_seats ?? 1));
  } else {
    unitRate = (input.hourly_rate !== undefined && input.hourly_rate >= 0)
      ? input.hourly_rate
      : space.hourly_rate;
    quantity = durationHours;
  }
  const effectiveRate = unitRate;
  let totalAmount = parseFloat((unitRate * quantity).toFixed(2));

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

  // 3a-bis. Booking credit redemption (partial-checkout carry-forward)
  // The customer (or staff) chose to apply an existing credit to this
  // booking. The credit covers `hours_to_redeem` hours at the credit's
  // *snapshot* hourly rate — protects the customer if rates have moved
  // between issue and redemption (locked policy: protect the customer).
  //
  // Discount is applied to the ex-GST subtotal so GST is collected on
  // whatever the customer actually pays in cash. We don't pro-rate the
  // facility charges — the customer still pays full price for any
  // upcharged facilities (projector, etc.).
  let creditId: string | null = null;
  let creditDiscount = 0;
  let creditHoursRedeemed = 0;
  if (body.credit_id) {
    const { data: credit, error: cErr } = await supabase
      .from("booking_credits")
      .select("id, location_id, hours_total, hours_used, hourly_rate_snapshot, expires_at, status")
      .eq("id", body.credit_id)
      .single();

    if (cErr || !credit) {
      return NextResponse.json({ error: "Credit not found" }, { status: 404 });
    }
    if (credit.status !== "active") {
      return NextResponse.json({ error: `Credit is ${credit.status} — not redeemable` }, { status: 400 });
    }
    if (credit.location_id !== space.location_id) {
      return NextResponse.json(
        { error: "Credit is for a different centre — credits are not transferable across locations" },
        { status: 400 }
      );
    }
    if (new Date(credit.expires_at) <= new Date()) {
      return NextResponse.json({ error: "Credit has expired" }, { status: 400 });
    }

    const remaining = Number(credit.hours_total) - Number(credit.hours_used);
    const requested = Number(body.hours_to_redeem ?? remaining);
    if (!Number.isFinite(requested) || requested < 1 || !Number.isInteger(requested)) {
      return NextResponse.json({ error: "hours_to_redeem must be a whole number ≥ 1" }, { status: 400 });
    }
    // Cap redemption at both the credit's remaining hours AND the
    // booking's actual duration — paying for "5 hrs of credit" on a
    // 3-hour booking would silently waste 2 hrs of the customer's credit.
    const maxRedeemable = Math.min(remaining, Math.floor(durationHours));
    if (requested > maxRedeemable) {
      return NextResponse.json(
        { error: `Cannot redeem ${requested}h — only ${maxRedeemable}h applicable (booking is ${durationHours}h, credit has ${remaining}h)` },
        { status: 400 }
      );
    }

    creditId = credit.id;
    creditHoursRedeemed = requested;
    creditDiscount = parseFloat((requested * Number(credit.hourly_rate_snapshot)).toFixed(2));
    totalAmount = parseFloat((totalAmount - creditDiscount).toFixed(2));
    if (totalAmount < 0) totalAmount = 0; // defensive — shouldn't happen given the cap above
  }

  // GST calculation — conference room bookings attract 18% GST. Computed
  // AFTER credit discount so customers are billed GST only on the cash
  // portion. Keeps the receipt aligned with what's actually collected.
  const gstRate = 18;
  const gstAmount = parseFloat((totalAmount * gstRate / 100).toFixed(2));
  const totalAmountWithGst = parseFloat((totalAmount + gstAmount).toFixed(2));

  // 3b. Prepaid purchase validation (if caller passes prepaid_purchase_id in body)
  let prepaidPurchaseId: string | undefined;
  let prepaidCreditsUsed: number | undefined;
  let prepaidTopupAmount: number | undefined;

  if (body.prepaid_purchase_id) {
    const { data: prepaidPurchase, error: ppErr } = await supabase
      .from("prepaid_purchases")
      .select("id, status, expires_at, credit_type, total_credits, credits_used")
      .eq("id", body.prepaid_purchase_id)
      .single();

    if (ppErr || !prepaidPurchase) {
      return NextResponse.json({ error: "Prepaid purchase not found" }, { status: 404 });
    }
    if (prepaidPurchase.status !== "active") {
      return NextResponse.json({ error: "Prepaid purchase is not active" }, { status: 400 });
    }
    const todayStr = new Date().toISOString().split("T")[0];
    if (prepaidPurchase.expires_at < todayStr) {
      return NextResponse.json({ error: "Prepaid purchase has expired" }, { status: 400 });
    }

    const creditsRemaining = Number(prepaidPurchase.total_credits) - Number(prepaidPurchase.credits_used);
    if (creditsRemaining <= 0) {
      return NextResponse.json({ error: "Prepaid purchase has no credits remaining" }, { status: 400 });
    }

    prepaidPurchaseId = prepaidPurchase.id;

    if (prepaidPurchase.credit_type === "hours") {
      const creditsToDeduct = Math.min(durationHours, creditsRemaining);
      prepaidCreditsUsed = creditsToDeduct;
      const topupHours = durationHours - creditsToDeduct;
      prepaidTopupAmount = topupHours > 0 ? parseFloat((topupHours * effectiveRate).toFixed(2)) : 0;
    } else {
      // Days pass OR Booking Slots pass: 1 credit per booking regardless of duration
      prepaidCreditsUsed = Math.min(1, creditsRemaining);
      prepaidTopupAmount = 0;
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

    // ── Quota-aware usage charge ───────────────────────────────────────────
    // For hourly bookings: look up contract_facilities with an hour-based unit.
    // If a matching facility exists we check how many hours have already been
    // consumed this calendar month and only charge the overage beyond the
    // negotiated free quota.  Daily-space bookings bypass quota logic entirely
    // (they're day-pass hot-desks, not conference hours).
    const HOUR_UNITS = ["hr", "hrs", "hour", "hours", "h"];
    let contractFacilityForQuota: {
      id: string; name: string; unit: string;
      free_quota: number; cost_per_unit: number;
    } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let quotaBookingsData: any[] | null = null;

    if (!isDaily) {
      // Fetch contract facilities and existing bookings in parallel
      // (both only need contract.id — no dependency between them).
      // If no hour-based facility exists, the bookings data is unused
      // but the speculative fetch saves a round-trip when it IS needed.
      const bDate = new Date(input.booking_date + "T00:00:00");
      const yr = bDate.getFullYear();
      const mo = bDate.getMonth(); // 0-based
      const monthStart = new Date(yr, mo, 1).toISOString().split("T")[0];
      const monthEnd   = new Date(yr, mo + 1, 0).toISOString().split("T")[0];

      const [{ data: contractFacilities }, { data: ebData }] = await Promise.all([
        supabase
          .from("contract_facilities")
          .select("id, name, unit, free_quota, cost_per_unit")
          .eq("contract_id", contract.id)
          .in("unit", HOUR_UNITS),
        supabase
          .from("bookings")
          .select("duration_hours")
          .eq("contract_id", contract.id)
          .gte("booking_date", monthStart)
          .lte("booking_date", monthEnd)
          .in("status", ["confirmed", "checked_in", "checked_out"]),
      ]);
      quotaBookingsData = ebData;

      if (contractFacilities && contractFacilities.length > 0) {
        if (contractFacilities.length === 1) {
          contractFacilityForQuota = contractFacilities[0];
        } else {
          // Multiple hour-based facilities — name-match against the space being booked
          const spaceLower = space.name.toLowerCase();
          contractFacilityForQuota =
            contractFacilities.find(
              (f: { name: string }) =>
                spaceLower.includes(f.name.toLowerCase()) ||
                f.name.toLowerCase().includes(spaceLower)
            ) || contractFacilities[0]; // fallback to first
        }
      }
    }

    let chargeDescription: string;
    let chargeQty: number;
    let chargeUnitPrice: number;
    let chargeTotal: number;
    let chargeStatus: string;

    if (contractFacilityForQuota) {
      // Use the existing bookings fetched above (parallel with contract_facilities)
      const hoursUsedSoFar = (quotaBookingsData || []).reduce(
        (sum: number, b: { duration_hours: number | null }) =>
          sum + Number(b.duration_hours || 0),
        0
      );

      const freeQuota    = Number(contractFacilityForQuota.free_quota);
      const freeRemaining = Math.max(0, freeQuota - hoursUsedSoFar);
      const overageHours  = Math.max(0, durationHours - freeRemaining);
      const overageRate   = Number(contractFacilityForQuota.cost_per_unit);
      const facilityName  = contractFacilityForQuota.name;

      if (overageHours > 0) {
        chargeQty       = overageHours;
        chargeUnitPrice = overageRate;
        chargeTotal     = parseFloat((overageHours * overageRate).toFixed(2));
        chargeStatus    = "pending";
        chargeDescription =
          `${facilityName} Overage: ${space.name} — ${overageHours}hr charged ` +
          `(prior usage: ${hoursUsedSoFar}hr, quota: ${freeQuota}hr/mo)`;
      } else {
        chargeQty       = durationHours;
        chargeUnitPrice = 0;
        chargeTotal     = 0;
        chargeStatus    = "waived";
        chargeDescription =
          `${facilityName}: ${space.name} — ${durationHours}hr ` +
          `(within ${freeQuota}hr/mo quota, used ${hoursUsedSoFar + durationHours}hr total)`;
      }
    } else {
      // No hour-based contract facility configured — charge the full booking rate
      chargeDescription = `Conference Room: ${space.name} (${input.start_time}–${input.end_time}, ${input.booking_date})`;
      chargeQty         = isDaily ? quantity : durationHours;
      chargeUnitPrice   = effectiveRate;
      chargeTotal       = totalAmount;
      chargeStatus      = "pending";
    }

    // Note: booking_id is set AFTER the booking row is inserted further below
    // (we only have the contract here). We'll patch booking_id onto this
    // charge row once the booking has been created. Without that link,
    // /billing can't trace from a booking back to its posted charge — which
    // was confusing finance.
    const { data: charge, error: chargeErr } = await supabase
      .from("usage_charges")
      .insert({
        contract_id:          contract.id,
        lead_id:              contract.lead_id,
        description:          chargeDescription,
        quantity:             chargeQty,
        unit_price:           chargeUnitPrice,
        total:                chargeTotal,
        charge_date:          input.booking_date,
        status:               chargeStatus,
        created_by:           dbUser.id,
        contract_facility_id: contractFacilityForQuota?.id ?? null,
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
    if (input.lead_id) {
      leadId = input.lead_id;
    } else {
      // Auto-create or find lead from guest details
      leadId = (await findOrCreateLeadForBooking(supabase, {
        guestName: input.guest_name,
        guestEmail: input.guest_email,
        guestPhone: input.guest_phone,
        bookerPhone: input.booker_phone,
        guestCompany: input.guest_company,
        guestGstNumber: input.booker_gst_number,
        locationId: space.location_id,
        createdBy: dbUser.id,
      })) || undefined;
    }
    paymentStatus = "pending";
  }

  // Override payment status when a prepaid purchase is applied
  if (prepaidPurchaseId) {
    paymentStatus = prepaidTopupAmount && prepaidTopupAmount > 0 ? "pending" : "prepaid";
  }

  // ── Complimentary booking (₹0 grand total) ───────────────────────
  // When the booking is genuinely free — staff overrode the rate to 0,
  // or the only line items are complimentary facilities — there's
  // nothing to collect. Defaulting to "pending" (the previous
  // behaviour) read as "Payment Pending ₹0" everywhere, confusing
  // finance. Auto-set to "waived" + capture the staff-supplied reason
  // for the audit trail. The reason is required in the request body
  // when total = 0 (validated below).
  const VALID_COMP_REASONS = new Set([
    "manager_goodwill", "aggregator_demo", "staff_use",
    "event_partnership", "other",
  ]);
  let complimentaryReason: string | null = null;
  let complimentaryDetails: string | null = null;
  if (totalAmountWithGst <= 0) {
    const reason = body.complimentary_reason as string | undefined;
    const details = (body.complimentary_details as string | undefined)?.trim() || null;
    if (!reason || !VALID_COMP_REASONS.has(reason)) {
      return NextResponse.json(
        { error: "complimentary_reason is required for ₹0 bookings (must be a valid picklist value)" },
        { status: 400 }
      );
    }
    if (reason === "other" && !details) {
      return NextResponse.json(
        { error: "complimentary_details required when reason is 'other'" },
        { status: 400 }
      );
    }
    paymentStatus = "waived";
    complimentaryReason = reason;
    complimentaryDetails = details;
  }

  // For guest type, create/find lead for the guest person (separate from contract holder)
  if (input.customer_type === "guest") {
    const guestLeadId = await findOrCreateLeadForBooking(supabase, {
      guestName: input.guest_name,
      guestEmail: input.guest_email,
      guestPhone: input.guest_phone,
      bookerPhone: input.booker_phone,
      guestCompany: input.guest_company,
      guestGstNumber: input.booker_gst_number,
      locationId: space.location_id,
      createdBy: dbUser.id,
    });
    if (guestLeadId) {
      leadId = guestLeadId; // Booking tracks the guest, not the contract holder
    }
    // Note: usage charge is already linked to contract via contractId + contract.lead_id
  }

  // 5. Insert booking
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .insert({
      space_id: input.space_id,
      location_id: space.location_id,
      booking_date: input.booking_date,
      start_time: effectiveStart + ":00",
      end_time: effectiveEnd + ":00",
      duration_hours: isDaily ? 1 : durationHours,
      pricing_model: space.pricing_model,
      unit_rate: unitRate,
      quantity,
      customer_type: input.customer_type,
      contract_id: contractId,
      lead_id: leadId,
      booker_phone: input.booker_phone,
      guest_name: input.guest_name,
      guest_email: input.guest_email || null,
      guest_phone: input.guest_phone,
      guest_company: input.guest_company,
      hourly_rate: effectiveRate,    // legacy column — for daily, this equals the day rate
      total_amount: totalAmount,
      gst_rate: gstRate,
      gst_amount: gstAmount,
      total_amount_with_gst: totalAmountWithGst,
      payment_status: paymentStatus,
      payment_mode: input.payment_mode,
      payment_reference: input.payment_reference,
      usage_charge_id: usageChargeId,
      prepaid_purchase_id: prepaidPurchaseId || null,
      prepaid_credits_used: prepaidCreditsUsed || null,
      prepaid_topup_amount: prepaidTopupAmount || null,
      credit_redeemed_id: creditId,
      complimentary_reason: complimentaryReason,
      complimentary_details: complimentaryDetails,
      notes: input.notes,
      aggregator_booking_id: input.aggregator_booking_id || null,
      num_attendees: input.num_attendees ? Number(input.num_attendees) : null,
      created_by: dbUser.id,
    })
    .select("*")
    .single();

  if (bookingErr) {
    return NextResponse.json({ error: bookingErr.message }, { status: 500 });
  }

  // ── Post-insert: run all independent side-effects in parallel ────
  // Steps 6–11 are independent of each other and can run concurrently.
  // This replaces ~12 sequential DB calls with one parallel batch,
  // saving 400-800ms on a typical booking creation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postInsertTasks: PromiseLike<any>[] = [];

  // 6. Insert booking facilities
  if (requestedFacilities.length > 0) {
    postInsertTasks.push(
      supabase.from("booking_facilities").insert(
        requestedFacilities.map((f) => ({ booking_id: booking.id, ...f }))
      )
    );
  }

  // 6a. Patch usage_charge with booking_id (finance traceability)
  if (usageChargeId) {
    postInsertTasks.push(
      supabase.from("usage_charges").update({ booking_id: booking.id }).eq("id", usageChargeId)
    );
  }

  // 6a-bis. Atomic credit redemption (single RPC prevents double-spend)
  if (creditId && creditHoursRedeemed > 0) {
    postInsertTasks.push((async () => {
      const { data: result, error: rpcErr } = await supabase.rpc("redeem_booking_credit", {
        p_credit_id: creditId,
        p_hours_to_redeem: creditHoursRedeemed,
      });

      if (rpcErr) {
        console.error("[booking] credit redemption RPC failed:", rpcErr.message);
        return;
      }

      const row = Array.isArray(result) ? result[0] : result;
      if (row?.success) {
        logAudit(supabase, {
          entityType: "booking_credit",
          entityId: creditId,
          action: "update",
          performedBy: dbUser.id,
          changes: {
            hours_used: { old: row.old_hours_used, new: row.new_hours_used },
            redeemed_on_booking_id: { old: null, new: booking.id },
            ...(row.new_status === "exhausted" ? { status: { old: "active", new: "exhausted" } } : {}),
          },
        });
      } else {
        console.error("[booking] credit redemption failed — credit no longer active or insufficient hours");
      }
    })());
  }

  // 6b. Prepaid redemption — atomic RPC prevents double-spend
  if (prepaidPurchaseId && prepaidCreditsUsed) {
    postInsertTasks.push((async () => {
      const { data: rpcResult, error: rpcError } = await supabase.rpc("redeem_prepaid_credits", {
        p_purchase_id: prepaidPurchaseId,
        p_booking_id: booking.id,
        p_credits_to_deduct: prepaidCreditsUsed,
        p_redeemed_by: dbUser.id,
      });

      if (rpcError) {
        console.error("[booking] prepaid redemption RPC error:", rpcError);
      } else if (rpcResult && rpcResult.length > 0 && !rpcResult[0].success) {
        console.error("[booking] prepaid redemption failed — insufficient credits or purchase not found");
      }
    })());
  }

  // 7. WiFi vouchers — no longer auto-issued at booking creation.
  //    Vouchers are now issued on-demand from the booking detail page
  //    via POST /api/bookings/[id]/vouchers. This:
  //      a) Speeds up booking creation (saves ~6 DB calls)
  //      b) Prevents voucher waste (staff chooses how many to issue)
  //      c) Avoids exposing unused codes on screen

  // 7b. Advance payment
  if (body.advance_payment && input.customer_type === "walk_in") {
    const { amount, payment_mode, payment_reference } = body.advance_payment;
    if (amount > 0 && (payment_mode === "cash" || payment_mode === "card")) {
      postInsertTasks.push((async () => {
        await supabase.from("booking_payments").insert({
          booking_id: booking.id,
          amount,
          payment_mode,
          payment_reference: payment_reference || null,
          status: "verified",
          created_by: dbUser.id,
        });
        if (amount >= totalAmount) {
          await supabase.from("bookings")
            .update({ payment_status: "paid", payment_mode })
            .eq("id", booking.id);
        }
      })());
    }
  }

  // 8. Lead activity log
  if (leadId) {
    const prepaidNote = prepaidPurchaseId
      ? ` [Prepaid: ${prepaidCreditsUsed} credit(s) deducted${prepaidTopupAmount && prepaidTopupAmount > 0 ? `, top-up ₹${prepaidTopupAmount}` : ""}]`
      : "";
    postInsertTasks.push(
      supabase.from("activities").insert({
        lead_id: leadId,
        type: "meeting",
        subject: `Conference Room Booking — ${space.name}`,
        description: `Booked ${space.name} on ${input.booking_date} from ${input.start_time}–${input.end_time} (${durationHours}hrs). Booking #${booking.booking_number}. Amount: ₹${totalAmount}.${prepaidNote}`,
        created_by: dbUser.id,
      })
    );
  }

  // 9. Audit log (fire-and-forget within the batch)
  logAudit(supabase, {
    entityType: "booking",
    entityId: booking.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: booking } },
  });

  // 11. Settle past dues
  if (input.settle_charge_ids && Array.isArray(input.settle_charge_ids) && input.settle_charge_ids.length > 0) {
    postInsertTasks.push(
      supabase.from("usage_charges").update({
        status: "billed",
        settled_in_booking_id: booking.id,
        settled_at: new Date().toISOString(),
      }).in("id", input.settle_charge_ids).eq("status", "pending")
    );
  }

  // Execute all post-insert operations in parallel
  await Promise.all(postInsertTasks);

  // 10. WhatsApp/SMS confirmation — fire-and-forget (no await)
  const phones = [booking.guest_phone as string | null, booking.booker_phone as string | null]
    .filter((p): p is string => !!p)
    .filter((p, i, arr) => arr.indexOf(p) === i);
  if (phones.length > 0) {
    const bookingDate = new Date(booking.booking_date as string).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric", month: "short", year: "numeric",
    });
    const guestName = (booking.guest_name as string) ?? "Guest";
    const bookingRef = (booking.booking_number as string) ?? (booking.id as string).slice(0, 8);
    phones.forEach((phone) => {
      if (body.send_whatsapp !== false) {
        messaging.bookingConfirmation(phone, guestName, bookingRef, bookingDate, booking.id as string).catch(console.error);
      }
      if (body.send_sms !== false) {
        dltSms.bookingConfirmation(phone, guestName, bookingRef, booking.id as string).catch(console.error);
      }
    });
  }

  // 12. Return full booking (after all side-effects complete)
  const { data: fullBooking } = await supabase
    .from("bookings")
    .select("*, space:spaces!bookings_space_id_fkey(id, name, capacity, hourly_rate), location:locations!bookings_location_id_fkey(id, name, code), contract:contracts!bookings_contract_id_fkey(id, contract_number), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email), facilities:booking_facilities(*)")
    .eq("id", booking.id)
    .single();

  return NextResponse.json({ data: fullBooking }, { status: 201 });
}

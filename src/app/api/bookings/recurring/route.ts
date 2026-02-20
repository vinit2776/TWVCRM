import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createRecurringSeriesSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// GET — List all recurring series
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const activeOnly = searchParams.get("active_only") !== "false";

  let query = supabase
    .from("recurring_booking_series")
    .select("*, space:spaces!recurring_booking_series_space_id_fkey(id, name), contract:contracts!recurring_booking_series_contract_id_fkey(id, contract_number), lead:leads!recurring_booking_series_lead_id_fkey(id, first_name, last_name, company)")
    .order("created_at", { ascending: false });

  if (activeOnly) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

// POST — Create a recurring series + generate individual bookings
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
  const parsed = createRecurringSeriesSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });

  const input = parsed.data;

  // Fetch space for location + rate
  const { data: space } = await supabase
    .from("spaces")
    .select("id, name, location_id, hourly_rate, operating_hours")
    .eq("id", input.space_id)
    .single();

  if (!space) return NextResponse.json({ error: "Space not found" }, { status: 404 });

  // Calculate duration
  const [sh, sm] = input.start_time.split(":").map(Number);
  const [eh, em] = input.end_time.split(":").map(Number);
  const durationHours = (eh * 60 + em - sh * 60 - sm) / 60;
  if (durationHours <= 0) return NextResponse.json({ error: "End time must be after start time" }, { status: 400 });

  // Create the series record
  const { data: series, error: seriesError } = await supabase
    .from("recurring_booking_series")
    .insert({
      space_id: input.space_id,
      location_id: space.location_id,
      customer_type: input.customer_type,
      contract_id: input.contract_id || null,
      lead_id: input.lead_id || null,
      guest_name: input.guest_name || null,
      guest_phone: input.guest_phone || null,
      guest_email: input.guest_email || null,
      guest_company: input.guest_company || null,
      booker_phone: input.booker_phone,
      start_time: input.start_time,
      end_time: input.end_time,
      duration_hours: durationHours,
      frequency: input.frequency,
      day_of_week: input.day_of_week ?? null,
      day_of_month: input.day_of_month ?? null,
      series_start: input.series_start,
      series_end: input.series_end,
      facility_ids: input.facility_ids || [],
      notes: input.notes || null,
      created_by: dbUser.id,
    })
    .select()
    .single();

  if (seriesError) return NextResponse.json({ error: seriesError.message }, { status: 500 });

  // Generate booking dates based on frequency
  const dates = generateRecurringDates(
    input.series_start,
    input.series_end,
    input.frequency,
    input.day_of_week,
    input.day_of_month
  );

  const created: string[] = [];
  const skipped: string[] = [];

  for (const dateStr of dates) {
    // Check for conflicts
    const { data: conflicts } = await supabase
      .from("bookings")
      .select("id")
      .eq("space_id", input.space_id)
      .eq("booking_date", dateStr)
      .not("status", "in", "(cancelled,no_show)")
      .lt("start_time", input.end_time)
      .gt("end_time", input.start_time);

    if (conflicts && conflicts.length > 0) {
      skipped.push(dateStr);
      continue;
    }

    // Create booking
    const hourlyRate = space.hourly_rate;
    const totalAmount = hourlyRate * durationHours;

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        space_id: input.space_id,
        location_id: space.location_id,
        booking_date: dateStr,
        start_time: input.start_time,
        end_time: input.end_time,
        duration_hours: durationHours,
        customer_type: input.customer_type,
        contract_id: input.contract_id || null,
        lead_id: input.lead_id || null,
        guest_name: input.guest_name || null,
        guest_email: input.guest_email || null,
        guest_phone: input.guest_phone || null,
        guest_company: input.guest_company || null,
        booker_phone: input.booker_phone,
        hourly_rate: hourlyRate,
        total_amount: totalAmount,
        payment_status: input.customer_type === "contract_holder" ? "posted_to_bill" : "pending",
        status: "confirmed",
        series_id: series.id,
        notes: input.notes || null,
        created_by: dbUser.id,
      })
      .select("id, booking_number")
      .single();

    if (!bookingError && booking) {
      created.push(booking.booking_number);

      // Add facilities if specified
      if (input.facility_ids && input.facility_ids.length > 0) {
        const { data: spaceFacilities } = await supabase
          .from("space_facilities")
          .select("id, name, is_complimentary, charge_per_use")
          .in("id", input.facility_ids);

        if (spaceFacilities) {
          const facilityInserts = spaceFacilities.map(f => ({
            booking_id: booking.id,
            facility_name: f.name,
            is_complimentary: f.is_complimentary,
            charge: f.charge_per_use,
          }));
          await supabase.from("booking_facilities").insert(facilityInserts);
        }
      }
    } else {
      skipped.push(dateStr);
    }
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: series.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { recurring_series: { old: null, new: series.id }, bookings_created: { old: null, new: created.length } },
  });

  return NextResponse.json({
    data: series,
    created: created.length,
    skipped: skipped.length,
    skipped_dates: skipped,
    created_bookings: created,
  });
}

function generateRecurringDates(
  start: string,
  end: string,
  frequency: string,
  dayOfWeek?: number,
  dayOfMonth?: number
): string[] {
  const dates: string[] = [];
  const startDate = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  const current = new Date(startDate);

  while (current <= endDate) {
    const dateStr = current.toISOString().split("T")[0];

    switch (frequency) {
      case "daily":
        dates.push(dateStr);
        current.setDate(current.getDate() + 1);
        break;
      case "weekly":
        if (dayOfWeek !== undefined && current.getDay() === dayOfWeek) {
          dates.push(dateStr);
        } else if (dayOfWeek === undefined) {
          dates.push(dateStr);
        }
        current.setDate(current.getDate() + (dayOfWeek !== undefined ? 7 : 1));
        if (dayOfWeek !== undefined && dates.length === 0) {
          // Find first occurrence
          while (current.getDay() !== dayOfWeek && current <= endDate) {
            current.setDate(current.getDate() + 1);
          }
          continue;
        }
        break;
      case "biweekly":
        if (dayOfWeek !== undefined && current.getDay() === dayOfWeek) {
          dates.push(dateStr);
          current.setDate(current.getDate() + 14);
        } else if (dayOfWeek === undefined) {
          dates.push(dateStr);
          current.setDate(current.getDate() + 14);
        } else {
          current.setDate(current.getDate() + 1);
        }
        break;
      case "monthly":
        if (dayOfMonth !== undefined) {
          const targetDate = new Date(current.getFullYear(), current.getMonth(), dayOfMonth);
          if (targetDate >= startDate && targetDate <= endDate) {
            dates.push(targetDate.toISOString().split("T")[0]);
          }
          current.setMonth(current.getMonth() + 1);
        } else {
          dates.push(dateStr);
          current.setMonth(current.getMonth() + 1);
        }
        break;
      default:
        current.setDate(current.getDate() + 1);
    }
  }

  return [...new Set(dates)].sort();
}

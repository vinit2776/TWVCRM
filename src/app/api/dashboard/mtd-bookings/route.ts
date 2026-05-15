import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/mtd-bookings?location_id=<uuid>
 * Returns Month-To-Date invoiced value of bookings per location.
 *
 *  - Window: bookings whose booking_date falls in the current month.
 *  - Sum:    bookings.total_amount.
 *  - Excludes "free quota" bookings — contract holders with total_amount=0
 *    (member freebies included in their plan).
 *  - Returns only locations that had at least one chargeable booking.
 *  - Sorted by value descending.
 *
 * Access: admin, manager, accounts, office_admin, floor_manager.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const allowed = ["admin", "manager", "accounts", "office_admin", "floor_manager"];
  if (!dbUser || !allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationFilter = request.nextUrl.searchParams.get("location_id");

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  // Fetch bookings this month with their location.
  // Note: we DO NOT pre-filter total_amount=0 in SQL because a contract holder
  // with a non-zero total is a real (paid) booking we must keep. We strip the
  // free-quota rows in code below.
  let q = adminSupabase
    .from("bookings")
    .select("id, total_amount, customer_type, location_id, booking_date, status")
    .gte("booking_date", fmt(startOfMonth))
    .lte("booking_date", fmt(now));

  if (locationFilter) q = q.eq("location_id", locationFilter);

  const [{ data: bookings, error: bErr }, { data: locations, error: lErr }] = await Promise.all([
    q,
    adminSupabase.from("locations").select("id, name"),
  ]);

  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 });
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });

  type Booking = {
    id: string;
    total_amount: number | null;
    customer_type: string;
    location_id: string;
  };

  const locNameById = new Map<string, string>();
  for (const l of locations ?? []) locNameById.set(l.id as string, l.name as string);

  type Bucket = { total: number; count: number };
  const byLocation = new Map<string, Bucket>();

  for (const b of (bookings ?? []) as Booking[]) {
    const amount = Number(b.total_amount ?? 0);
    // Exclude free-quota bookings: contract holders with zero invoice value
    const isFreeQuota = b.customer_type === "contract_holder" && amount === 0;
    if (isFreeQuota) continue;

    const slot = byLocation.get(b.location_id) ?? { total: 0, count: 0 };
    slot.total += amount;
    slot.count += 1;
    byLocation.set(b.location_id, slot);
  }

  const rows = Array.from(byLocation.entries())
    .filter(([, v]) => v.count > 0) // only locations with transactions
    .map(([location_id, v]) => ({
      location_id,
      location_name: locNameById.get(location_id) ?? "Unknown",
      value: Math.round(v.total),
      bookings: v.count,
    }))
    .sort((a, b) => b.value - a.value);

  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalBookings = rows.reduce((s, r) => s + r.bookings, 0);

  return NextResponse.json({
    data: {
      total_value: totalValue,
      total_bookings: totalBookings,
      locations: rows,
    },
  });
}

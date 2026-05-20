import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/rent-revenue
 * Returns per-location: rent paid this month vs revenue billed this month.
 * Admin only — this endpoint surfaces financial data across all locations.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const paymentMonth = `${year}-${month}`;
  const periodStart  = `${year}-${month}-01`;
  // Last day of the month
  const periodEnd    = new Date(year, now.getMonth() + 1, 0).toISOString().slice(0, 10);

  // 1) Rent paid this month: lease_payments.status='paid', payment_month = current
  //    Join to property_leases → location_id
  const { data: rentRows } = await admin
    .from("lease_payments")
    .select("net_amount_paid, gross_rent_amount, tds_amount, lease:property_leases(location_id)")
    .eq("payment_month", paymentMonth)
    .eq("status", "paid");

  // 2) Revenue billed this month: billing_statements finalized/exported,
  //    period overlapping current month, join to contracts → location_id
  const { data: revenueRows } = await admin
    .from("billing_statements")
    .select("total_amount, contract:contracts(location_id)")
    .in("status", ["finalized", "exported"])
    .lte("period_start", periodEnd)
    .gte("period_end", periodStart);

  // 3) All locations for labelling
  const { data: locations } = await admin
    .from("locations")
    .select("id, name")
    .order("name");

  // Aggregate rent paid by location
  const rentByLocation: Record<string, number> = {};
  for (const row of rentRows ?? []) {
    const locId = (row.lease as { location_id?: string } | null)?.location_id;
    if (!locId) continue;
    rentByLocation[locId] = (rentByLocation[locId] ?? 0) + ((row.gross_rent_amount ?? 0) - (row.tds_amount ?? 0));
  }

  // Aggregate revenue by location
  const revenueByLocation: Record<string, number> = {};
  for (const row of revenueRows ?? []) {
    const locId = (row.contract as { location_id?: string } | null)?.location_id;
    if (!locId) continue;
    revenueByLocation[locId] = (revenueByLocation[locId] ?? 0) + (row.total_amount ?? 0);
  }

  // Build result — only locations that have either rent or revenue
  const result = (locations ?? [])
    .map((loc) => ({
      location_id: loc.id,
      location_name: loc.name,
      rent_paid: Math.round((rentByLocation[loc.id] ?? 0) * 100) / 100,
      revenue_billed: Math.round((revenueByLocation[loc.id] ?? 0) * 100) / 100,
      rent_ratio: revenueByLocation[loc.id]
        ? Math.round(((rentByLocation[loc.id] ?? 0) / revenueByLocation[loc.id]) * 1000) / 10
        : null,
    }))
    .filter((r) => r.rent_paid > 0 || r.revenue_billed > 0);

  return NextResponse.json({ data: result, paymentMonth });
}

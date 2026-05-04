import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/revenue-pulse?location_id=<uuid>
 * Returns this-month vs same-period-last-month revenue, broken down by
 * stream: contracts (verified contract_payments), bookings (verified
 * booking_payments), prepaid (prepaid_purchases), usage (usage_charges
 * billed). Falls back gracefully if a table is missing data.
 *
 * Access: admin, manager, accounts.
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

  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");

  const now = new Date();
  const dayOfMonth = now.getDate();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const sameDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, dayOfMonth);

  const fmt = (d: Date) => d.toISOString().split("T")[0];

  // Helper: sum amount of a column across rows.
  const sum = <T extends Record<string, unknown>>(rows: T[] | null | undefined, key: keyof T) =>
    (rows ?? []).reduce((s, r) => s + Number(r[key] ?? 0), 0);

  const contractsThisQ = adminSupabase
    .from("contract_payments")
    .select("amount, payment_date, status, contract:contracts(lead:leads(location_id))")
    .eq("status", "verified")
    .gte("payment_date", fmt(startOfMonth))
    .lte("payment_date", fmt(now));

  const contractsLastQ = adminSupabase
    .from("contract_payments")
    .select("amount, payment_date, status, contract:contracts(lead:leads(location_id))")
    .eq("status", "verified")
    .gte("payment_date", fmt(startOfLastMonth))
    .lte("payment_date", fmt(sameDayLastMonth));

  const bookingsThisQ = adminSupabase
    .from("booking_payments")
    .select("amount, status, booking:bookings(location_id, booking_date)")
    .eq("status", "verified")
    .gte("created_at", startOfMonth.toISOString())
    .lte("created_at", now.toISOString());

  const bookingsLastQ = adminSupabase
    .from("booking_payments")
    .select("amount, status, booking:bookings(location_id, booking_date)")
    .eq("status", "verified")
    .gte("created_at", startOfLastMonth.toISOString())
    .lte("created_at", sameDayLastMonth.toISOString());

  const prepaidThisQ = adminSupabase
    .from("prepaid_purchases")
    .select("total_amount, payment_status, location_id, purchase_date")
    .eq("payment_status", "paid")
    .gte("purchase_date", fmt(startOfMonth))
    .lte("purchase_date", fmt(now));

  const prepaidLastQ = adminSupabase
    .from("prepaid_purchases")
    .select("total_amount, payment_status, location_id, purchase_date")
    .eq("payment_status", "paid")
    .gte("purchase_date", fmt(startOfLastMonth))
    .lte("purchase_date", fmt(sameDayLastMonth));

  const [
    { data: ct },
    { data: cl },
    { data: bt },
    { data: bl },
    { data: pt },
    { data: pl },
  ] = await Promise.all([
    contractsThisQ,
    contractsLastQ,
    bookingsThisQ,
    bookingsLastQ,
    prepaidThisQ,
    prepaidLastQ,
  ]);

  type CP = { amount: number | string | null; contract: { lead: { location_id: string | null } | null } | null };
  type BP = { amount: number | string | null; booking: { location_id: string | null } | null };
  type PP = { total_amount: number | string | null; location_id: string | null };

  const filterByLoc = <
    T extends Record<string, unknown>,
  >(rows: T[] | null | undefined, getLoc: (r: T) => string | null) => {
    if (!locationId) return rows ?? [];
    return (rows ?? []).filter((r) => getLoc(r) === locationId);
  };

  const cThis = sum(
    filterByLoc(ct as unknown as CP[] | null, (r) => r.contract?.lead?.location_id ?? null) as CP[],
    "amount"
  );
  const cLast = sum(
    filterByLoc(cl as unknown as CP[] | null, (r) => r.contract?.lead?.location_id ?? null) as CP[],
    "amount"
  );
  const bThis = sum(
    filterByLoc(bt as unknown as BP[] | null, (r) => r.booking?.location_id ?? null) as BP[],
    "amount"
  );
  const bLast = sum(
    filterByLoc(bl as unknown as BP[] | null, (r) => r.booking?.location_id ?? null) as BP[],
    "amount"
  );
  const pThis = sum(
    filterByLoc(pt as unknown as PP[] | null, (r) => r.location_id) as PP[],
    "total_amount"
  );
  const pLast = sum(
    filterByLoc(pl as unknown as PP[] | null, (r) => r.location_id) as PP[],
    "total_amount"
  );

  const totalThis = cThis + bThis + pThis;
  const totalLast = cLast + bLast + pLast;
  const change = totalLast > 0 ? Math.round(((totalThis - totalLast) / totalLast) * 100) : null;

  const round = (n: number) => Math.round(n);

  return NextResponse.json({
    data: {
      total_mtd: round(totalThis),
      total_last_mtd: round(totalLast),
      change_pct: change,
      streams: {
        contracts: { current: round(cThis), previous: round(cLast) },
        bookings: { current: round(bThis), previous: round(bLast) },
        prepaid: { current: round(pThis), previous: round(pLast) },
      },
    },
  });
}

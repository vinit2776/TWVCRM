import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/procurement/amc
 * Returns all service POs linked to AMC material requests.
 * Filters: status, location_id, department
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const amcStatus   = searchParams.get("amc_status");   // active|expiring|expired|exhausted|inactive
  const locationId  = searchParams.get("location_id");
  const department  = searchParams.get("department");

  // ── Fetch service POs from AMC material requests ──────────────────────────
  // AMC POs can be:
  //  a) Service POs whose linked PR has expenditure_type = 'amc'
  //  b) Any PO that has amc_start_date set (manually activated)
  const query = supabase
    .from("purchase_orders")
    .select(`
      id, po_number, po_type, status, amc_status,
      amc_start_date, amc_end_date,
      amc_visits_covered, amc_visits_used,
      amc_contact_name, amc_helpline_number, amc_contact_email,
      total_ordered_amount, created_at,
      procurement_vendors(id, name),
      locations(id, name),
      purchase_requests(id, pr_number, department, expenditure_type),
      purchase_order_items(id, item_name, unit)
    `)
    .eq("po_type", "service")
    .order("created_at", { ascending: false });

  // Filter to AMC-related POs: either has amc_start_date OR linked PR is AMC
  // We do a broad fetch and filter in JS to avoid complex PostgREST OR on joined table
  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Keep only AMC POs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let amcRows = (rows ?? []).filter((r: any) =>
    r.amc_start_date != null ||
    r.purchase_requests?.expenditure_type === "amc"
  );

  // Recompute live amc_status for each row (in case DB value is stale)
  const today = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  amcRows = amcRows.map((r: any) => {
    const computed = computeAmcStatus(r.amc_start_date, r.amc_end_date, r.amc_visits_covered, r.amc_visits_used ?? 0, today);
    return { ...r, amc_status: computed };
  });

  // Apply filters
  if (amcStatus) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    amcRows = amcRows.filter((r: any) => r.amc_status === amcStatus);
  }
  if (locationId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    amcRows = amcRows.filter((r: any) => r.location_id === locationId);
  }
  if (department) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    amcRows = amcRows.filter((r: any) => r.purchase_requests?.department === department);
  }

  return NextResponse.json({ data: amcRows });
}

function computeAmcStatus(
  startDate: string | null,
  endDate: string | null,
  visitsCovered: number | null,
  visitsUsed: number,
  today: Date
): string {
  if (!startDate) return "inactive";
  const start = new Date(startDate);
  if (today < start) return "inactive";
  if (endDate) {
    const end = new Date(endDate);
    if (today > end) return "expired";
    const daysLeft = Math.floor((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 60) return "expiring";
  }
  if (visitsCovered !== null && visitsUsed >= visitsCovered) return "exhausted";
  return "active";
}

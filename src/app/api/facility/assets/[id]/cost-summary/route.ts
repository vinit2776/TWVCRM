import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/facility/assets/[id]/cost-summary
 * Returns monthly cost-of-ownership for an asset, aggregated from approved vendor bills
 * linked through: facility_issues → purchase_requests → purchase_orders → vendor_bills
 *
 * Response: { data: [{ month: "2025-03", cost: 12500 }, ...] }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Verify asset exists and is accessible
  const { data: asset } = await supabase
    .from("facility_assets")
    .select("id")
    .eq("id", id)
    .single();
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  // Use admin client for the join query (crosses RLS boundaries via FK chain)
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_asset_cost_summary", { asset_uuid: id });

  if (error) {
    // Fallback to raw query if RPC doesn't exist yet
    const { data: rows, error: queryErr } = await admin
      .from("facility_issues")
      .select(`
        purchase_requests!inner(
          purchase_orders!inner(
            vendor_bills!inner(
              invoice_date,
              total_amount,
              approval_status
            )
          )
        )
      `)
      .eq("asset_id", id)
      .eq("purchase_requests.purchase_orders.vendor_bills.approval_status", "approved");

    if (queryErr) return NextResponse.json({ error: queryErr.message }, { status: 500 });

    // Aggregate by month in JS since nested filtering is not reliable across deep joins
    const monthMap: Record<string, number> = {};
    for (const issue of rows ?? []) {
      const prs = (issue as unknown as { purchase_requests: { purchase_orders: { vendor_bills: { invoice_date: string; total_amount: number; approval_status: string }[] }[] }[] }).purchase_requests;
      for (const pr of prs ?? []) {
        for (const po of pr.purchase_orders ?? []) {
          for (const vb of po.vendor_bills ?? []) {
            if (vb.approval_status !== "approved") continue;
            const month = vb.invoice_date?.slice(0, 7) ?? "unknown";
            monthMap[month] = (monthMap[month] ?? 0) + (vb.total_amount ?? 0);
          }
        }
      }
    }

    const summary = Object.entries(monthMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, cost]) => ({ month, cost }));

    return NextResponse.json({ data: summary });
  }

  return NextResponse.json({ data: data ?? [] });
}

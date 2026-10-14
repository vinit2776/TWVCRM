import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";

/**
 * GET /api/dashboard/week-in-review
 * Returns a 7-day operations snapshot across all modules.
 * Access: admin only.
 */
export async function GET() {
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createAdminClient();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [
    // Sales
    { count: leadsCreated },
    { count: proposalsSent },
    { count: proposalsAccepted },
    { count: contractsActivated },
    { count: contractsExpiringSoon },
    // Billing
    { count: statementsGenerated },
    { data: paymentsCollectedData },
    { count: overdueStatements },
    { count: vendorBillsApproved },
    { data: vendorPaymentsData },
    // Procurement
    { count: prsRaised },
    { count: posCreated },
    { count: deliveriesConfirmed },
    { count: billsPendingApproval },
    // Facility
    { count: issuesOpened },
    { count: issuesResolved },
    { count: issuesOpen },
    { count: bookingsThisWeek },
    // Spaces
    { data: spaceUnits },
    { count: seatsOccupied },
    { count: seatsVacated },
    { count: newSeatAssignments },
    // Assets
    { count: warrantiesExpiring },
    { count: assetsAdded },
    { count: assetEventsLogged },
    { count: assetDocsUploaded },
  ] = await Promise.all([
    // Sales: leads created in last 7 days
    admin.from("leads").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Sales: proposals created in last 7 days
    admin.from("proposals").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Sales: proposals accepted in last 7 days
    admin.from("proposals").select("*", { count: "exact", head: true }).eq("status", "accepted").gte("updated_at", sevenDaysAgo),
    // Sales: contracts activated in last 7 days
    admin.from("contracts").select("*", { count: "exact", head: true }).eq("status", "active").gte("activated_at", sevenDaysAgo),
    // Sales: active contracts expiring in 30 days
    admin.from("contracts").select("*", { count: "exact", head: true }).eq("status", "active").gte("end_date", today).lte("end_date", thirtyDaysFromNow),
    // Billing: statements created in last 7 days
    admin.from("billing_statements").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Billing: payments collected in last 7 days
    admin.from("billing_payments").select("amount").gte("created_at", sevenDaysAgo),
    // Billing: overdue statements (unpaid and past due date)
    admin.from("billing_statements").select("*", { count: "exact", head: true }).eq("payment_status", "unpaid").lt("due_date", today).not("status", "eq", "voided"),
    // Billing: vendor bills approved in last 7 days
    admin.from("vendor_bills").select("*", { count: "exact", head: true }).eq("approval_status", "approved").gte("updated_at", sevenDaysAgo),
    // Billing: vendor payments made in last 7 days
    admin.from("vendor_bill_payments").select("amount").gte("created_at", sevenDaysAgo),
    // Procurement: PRs raised in last 7 days
    admin.from("purchase_requests").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Procurement: POs created in last 7 days
    admin.from("purchase_orders").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Procurement: deliveries confirmed in last 7 days
    admin.from("purchase_orders").select("*", { count: "exact", head: true }).eq("status", "delivered").gte("updated_at", sevenDaysAgo),
    // Procurement: vendor bills pending approval
    admin.from("vendor_bills").select("*", { count: "exact", head: true }).eq("approval_status", "pending"),
    // Facility: issues opened in last 7 days
    admin.from("facility_issues").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Facility: issues resolved in last 7 days
    admin.from("facility_issues").select("*", { count: "exact", head: true }).eq("status", "resolved").gte("updated_at", sevenDaysAgo),
    // Facility: currently open issues (not resolved/closed)
    admin.from("facility_issues").select("*", { count: "exact", head: true }).not("status", "in", '("resolved","closed")'),
    // Facility: bookings in last 7 days
    admin.from("bookings").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Spaces: active space units for capacity
    admin.from("space_units").select("capacity, type").eq("is_active", true),
    // Spaces: active seat occupants
    admin.from("space_seat_occupants").select("*", { count: "exact", head: true }).eq("status", "active"),
    // Spaces: seats vacated in last 7 days
    admin.from("space_seat_occupants").select("*", { count: "exact", head: true }).eq("status", "ended").gte("updated_at", sevenDaysAgo),
    // Spaces: new assignments in last 7 days
    admin.from("space_seat_occupants").select("*", { count: "exact", head: true }).eq("status", "active").gte("created_at", sevenDaysAgo),
    // Assets: warranties expiring in 30 days
    admin.from("facility_assets").select("*", { count: "exact", head: true }).eq("status", "active").gte("warranty_expiry", today).lte("warranty_expiry", thirtyDaysFromNow),
    // Assets: added in last 7 days
    admin.from("facility_assets").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Assets: lifecycle events logged in last 7 days
    admin.from("facility_asset_events").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    // Assets: documents uploaded in last 7 days
    admin.from("asset_documents").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
  ]);

  const totalCapacity = (spaceUnits ?? [])
    .filter((u) => u.type !== "business_centre")
    .reduce((s: number, u: { capacity: number }) => s + (u.capacity ?? 0), 0);

  const paymentsCollected = (paymentsCollectedData ?? []).reduce(
    (s: number, p: { amount: number }) => s + Number(p.amount ?? 0),
    0
  );
  const vendorPaymentsTotal = (vendorPaymentsData ?? []).reduce(
    (s: number, p: { amount: number }) => s + Number(p.amount ?? 0),
    0
  );

  const occupied = seatsOccupied ?? 0;
  const occupancyPct = totalCapacity > 0 ? Math.round((occupied / totalCapacity) * 100) : 0;

  return NextResponse.json({
    data: {
      sales: {
        leads_created: leadsCreated ?? 0,
        proposals_sent: proposalsSent ?? 0,
        proposals_accepted: proposalsAccepted ?? 0,
        contracts_activated: contractsActivated ?? 0,
        contracts_expiring_soon: contractsExpiringSoon ?? 0,
      },
      billing: {
        statements_generated: statementsGenerated ?? 0,
        payments_collected: Math.round(paymentsCollected),
        overdue_statements: overdueStatements ?? 0,
        vendor_bills_approved: vendorBillsApproved ?? 0,
        vendor_payments_total: Math.round(vendorPaymentsTotal),
      },
      procurement: {
        prs_raised: prsRaised ?? 0,
        pos_created: posCreated ?? 0,
        deliveries_confirmed: deliveriesConfirmed ?? 0,
        bills_pending_approval: billsPendingApproval ?? 0,
      },
      facility: {
        issues_opened: issuesOpened ?? 0,
        issues_resolved: issuesResolved ?? 0,
        issues_open: issuesOpen ?? 0,
        bookings: bookingsThisWeek ?? 0,
      },
      spaces: {
        total_capacity: totalCapacity,
        occupied,
        vacated: seatsVacated ?? 0,
        new_assignments: newSeatAssignments ?? 0,
        occupancy_pct: occupancyPct,
      },
      assets: {
        warranties_expiring: warrantiesExpiring ?? 0,
        assets_added: assetsAdded ?? 0,
        lifecycle_events: assetEventsLogged ?? 0,
        documents_uploaded: assetDocsUploaded ?? 0,
      },
    },
  });
}

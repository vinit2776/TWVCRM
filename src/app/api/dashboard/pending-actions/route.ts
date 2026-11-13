import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";

export interface PendingActionItem {
  module: string;
  title: string;
  subtitle: string;
  link: string;
  created_at: string;
  id: string;
}

/**
 * GET /api/dashboard/pending-actions
 *
 * Returns pending items across modules that need admin action.
 * Admin-only endpoint — non-admins get an empty list.
 */
export async function GET() {
  const supabase = await createClient();
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ data: [] });

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ data: [] });
  }

  const items: PendingActionItem[] = [];

  // Run queries in parallel
  const [waiverRes, billsRes, materialsRes, electricityRes] = await Promise.all([
    // 1. Deposit waiver OTP requests (zero-deposit proposals awaiting admin OTP)
    supabase
      .from("proposals")
      .select("id, proposal_number, total_amount, deposit_waiver_requested_at, lead:leads!proposals_lead_id_fkey(first_name, last_name, company)")
      .eq("security_deposit_months", 0)
      .not("deposit_waiver_requested_at", "is", null)
      .is("deposit_waiver_verified_at", null)
      .order("deposit_waiver_requested_at", { ascending: true })
      .limit(20),

    // 2. Vendor bills pending approval
    supabase
      .from("vendor_bills")
      .select("id, bill_number, vendor_name, total_amount, created_at")
      .eq("approval_status", "pending")
      .order("created_at", { ascending: true })
      .limit(20),

    // 3. Material requests pending approval
    supabase
      .from("material_requests")
      .select("id, request_number, title, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(20),

    // 4. Landlord electricity bills awaiting Approve & Generate
    supabase
      .from("electricity_bills")
      .select("id, landlord_bill_number, landlord_total_amount, bill_month, bill_year, created_at, locations(name, code)")
      .eq("bill_side", "landlord")
      .eq("status", "draft")
      .order("created_at", { ascending: true })
      .limit(20),
  ]);

  // Map deposit waiver requests
  if (waiverRes.data) {
    for (const p of waiverRes.data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = p.lead as any;
      const name = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "";
      items.push({
        module: "Deposit Waiver",
        title: `${p.proposal_number} — Zero Deposit OTP`,
        subtitle: `${name}${lead?.company ? ` (${lead.company})` : ""} · ₹${Number(p.total_amount).toLocaleString("en-IN")}/mo`,
        link: `/proposals/${p.id}`,
        created_at: p.deposit_waiver_requested_at,
        id: `waiver-${p.id}`,
      });
    }
  }

  // Map vendor bills
  if (billsRes.data) {
    for (const b of billsRes.data) {
      items.push({
        module: "Vendor Bills",
        title: `${b.bill_number || "Bill"} — Approval Required`,
        subtitle: `${b.vendor_name} · ₹${Number(b.total_amount).toLocaleString("en-IN")}`,
        link: `/procurement/bills/${b.id}`,
        created_at: b.created_at,
        id: `bill-${b.id}`,
      });
    }
  }

  // Map material requests
  if (materialsRes.data) {
    for (const m of materialsRes.data) {
      items.push({
        module: "Material Requests",
        title: `${m.request_number || "MR"} — Approval Required`,
        subtitle: m.title || "Material request",
        link: `/procurement/requests/${m.id}`,
        created_at: m.created_at,
        id: `mr-${m.id}`,
      });
    }
  }

  // Map electricity bills
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (electricityRes.data) {
    for (const b of electricityRes.data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const location = b.locations as any;
      items.push({
        module: "Electricity Bills",
        title: `${b.landlord_bill_number || "Landlord bill"} — Approval Required`,
        subtitle: `${location?.name ?? "Unknown location"} · ${MONTH_NAMES[b.bill_month - 1]} ${b.bill_year} · ₹${Number(b.landlord_total_amount).toLocaleString("en-IN")}`,
        link: `/procurement/electricity`,
        created_at: b.created_at,
        id: `eb-${b.id}`,
      });
    }
  }

  // Sort by oldest first
  items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return NextResponse.json({ data: items });
}

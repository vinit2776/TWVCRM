import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

// Runs 1st of month at 08:00 IST (02:30 UTC)
// Idempotent — ON CONFLICT (lease_id, payment_month) DO NOTHING
//
// Approval modes:
//   blanket → payment generated as "approved" (admin pre-approved all future payments)
//   manual  → payment generated as "pending" (admin must approve individually)
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const today = new Date();
  const year  = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const paymentMonth = `${year}-${month}`;
  const dueDate = `${year}-${month}-05`;

  const { data: leases, error: leaseErr } = await admin
    .from("property_leases")
    .select("id, base_rent_amount, tds_rate, maintenance_charges, approval_mode")
    .eq("status", "active");

  if (leaseErr) return NextResponse.json({ error: leaseErr.message }, { status: 500 });
  if (!leases?.length) return NextResponse.json({ generated: 0 });

  let generated = 0;
  let skipped = 0;

  for (const lease of leases) {
    const tdsRate   = lease.tds_rate ?? 10;
    const grossRent = lease.base_rent_amount + (lease.maintenance_charges ?? 0);
    const tdsAmount = Math.round(grossRent * tdsRate / 100);

    const isBlanket    = lease.approval_mode === "blanket";
    const status       = isBlanket ? "approved" : "pending";
    const approvedAt   = isBlanket ? today.toISOString() : null;

    const { error: insertErr } = await admin
      .from("lease_payments")
      .insert({
        lease_id:           lease.id,
        payment_month:      paymentMonth,
        due_date:           dueDate,
        gross_rent_amount:  grossRent,
        tds_amount:         tdsAmount,
        net_amount_paid:    grossRent - tdsAmount,
        status,
        admin_approved_at:  approvedAt,
        auto_approved:      isBlanket,
      });

    if (insertErr) {
      if (insertErr.code === "23505") skipped++;
      else console.error(`lease-payment-generator: lease ${lease.id}:`, insertErr.message);
    } else {
      generated++;
    }
  }

  return NextResponse.json({ generated, skipped, paymentMonth });
}

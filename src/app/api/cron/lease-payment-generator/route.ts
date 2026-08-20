import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";

// Runs 1st of month at 08:00 IST (02:30 UTC)
// Idempotent — ON CONFLICT (lease_id, payment_month) DO NOTHING
//
// Blanket auto-approval rules (checked at generation time):
//   1. approval_mode must be "blanket"
//   2. blanket_on_hold must be false  (OR blanket_hold_until has passed today)
//   3. blanket_expires_on must be null (whole tenure) OR >= paymentMonth
//
// If all 3 pass → status = "approved", auto_approved = true
// Otherwise     → status = "pending"

function isBlanketActive(
  lease: {
    approval_mode: string;
    blanket_on_hold: boolean;
    blanket_hold_until: string | null;
    blanket_expires_on: string | null;
    lease_end_date: string;
  },
  paymentMonth: string,
  todayDate: string
): boolean {
  if (lease.approval_mode !== "blanket") return false;

  // Hold check: skip auto-approval if hold is active
  if (lease.blanket_on_hold) {
    if (!lease.blanket_hold_until) return false;       // indefinite hold
    if (lease.blanket_hold_until >= todayDate) return false; // hold period still active
    // hold_until < today → hold has expired, treat as not on hold
  }

  // Expiry check: blanket_expires_on = null means whole lease tenure
  if (lease.blanket_expires_on && lease.blanket_expires_on < paymentMonth) return false;

  return true;
}

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const today = new Date();
  const todayDate = today.toISOString().slice(0, 10);
  const year  = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const paymentMonth = `${year}-${month}`;
  const dueDate = `${year}-${month}-05`;

  const { data: leases, error: leaseErr } = await admin
    .from("property_leases")
    .select("id, base_rent_amount, tds_rate, maintenance_charges, approval_mode, blanket_on_hold, blanket_hold_until, blanket_expires_on, lease_end_date")
    .eq("status", "active");

  if (leaseErr) return NextResponse.json({ error: leaseErr.message }, { status: 500 });
  if (!leases?.length) return NextResponse.json({ generated: 0 });

  let generated = 0;
  let skipped = 0;
  let holdLifts = 0;

  // Auto-lift expired holds before generating payments
  for (const lease of leases) {
    if (
      lease.blanket_on_hold &&
      lease.blanket_hold_until &&
      lease.blanket_hold_until < todayDate
    ) {
      await admin
        .from("property_leases")
        .update({ blanket_on_hold: false, blanket_hold_until: null })
        .eq("id", lease.id);
      lease.blanket_on_hold = false;
      lease.blanket_hold_until = null;
      holdLifts++;
    }
  }

  for (const lease of leases) {
    const tdsRate   = lease.tds_rate ?? 10;
    const grossRent = lease.base_rent_amount + (lease.maintenance_charges ?? 0);
    const tdsAmount = Math.round(grossRent * tdsRate / 100);

    const autoApprove  = isBlanketActive(lease, paymentMonth, todayDate);
    const status       = autoApprove ? "approved" : "pending";
    const approvedAt   = autoApprove ? today.toISOString() : null;

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
        auto_approved:      autoApprove,
      });

    if (insertErr) {
      if (insertErr.code === "23505") skipped++;
      else console.error(`lease-payment-generator: lease ${lease.id}:`, insertErr.message);
    } else {
      generated++;
    }
  }

  return NextResponse.json({ generated, skipped, holdLifts, paymentMonth });
}

export const GET = withCronHealth("cron/lease-payment-generator", handler);

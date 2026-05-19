import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

// Runs 1st of month at 08:00 IST (02:30 UTC)
// Idempotent — ON CONFLICT (lease_id, payment_month) DO NOTHING
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const today = new Date();
  const paymentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  // Due on the 5th of the month
  const dueDay = 5;
  const dueDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-0${dueDay}`;

  const { data: leases, error: leaseErr } = await admin
    .from("property_leases")
    .select("id, base_rent_amount, tds_rate, tds_section, maintenance_charges")
    .eq("status", "active");

  if (leaseErr) {
    return NextResponse.json({ error: leaseErr.message }, { status: 500 });
  }

  if (!leases || leases.length === 0) {
    return NextResponse.json({ generated: 0 });
  }

  // Read auto-approve threshold from app_settings
  const { data: setting } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "lease_auto_approve_threshold")
    .single();
  const threshold = setting ? parseInt(setting.value) : 50000;

  let generated = 0;
  let skipped = 0;

  for (const lease of leases) {
    const tdsRate = lease.tds_rate ?? 10;
    const grossRent = lease.base_rent_amount + (lease.maintenance_charges ?? 0);
    const tdsAmount = Math.round(grossRent * tdsRate / 100);
    const netAmount = grossRent - tdsAmount;

    // Check if a verified primary bank account exists for auto-approval
    const { data: bankAcct } = await admin
      .from("landlord_bank_accounts")
      .select("id, is_verified")
      .eq("is_primary", true)
      .eq("is_verified", true)
      .in("landlord_id", (
        admin.from("property_leases").select("landlord_id").eq("id", lease.id)
      ) as never)
      .maybeSingle();

    const canAutoApprove = netAmount <= threshold && !!bankAcct;
    const status = canAutoApprove ? "paid" : "pending";
    const paidDate = canAutoApprove ? today.toISOString().split("T")[0] : null;

    const { error: insertErr } = await admin
      .from("lease_payments")
      .insert({
        lease_id: lease.id,
        payment_month: paymentMonth,
        due_date: dueDate,
        gross_rent_amount: grossRent,
        tds_amount: tdsAmount,
        net_amount_paid: netAmount,
        status,
        paid_date: paidDate,
        auto_approved: canAutoApprove,
        payment_mode: canAutoApprove ? "bank_transfer" : null,
      })
      .select("id")
      .single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        skipped++;
      } else {
        console.error(`lease-payment-generator: lease ${lease.id} error:`, insertErr.message);
      }
    } else {
      generated++;
    }
  }

  return NextResponse.json({ generated, skipped, paymentMonth });
}

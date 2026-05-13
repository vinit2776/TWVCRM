import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToAll } from "@/lib/push";
import {
  loadFinanceIntelligenceConfig,
  isFeatureEnabled,
  median,
  logSuggestion,
} from "@/lib/finance-intelligence";

/**
 * GET /api/cron/invoice-gap-audit
 *
 * Runs weekly (Monday 04:00 UTC). Finds vendors whose last invoice is
 * overdue relative to their normal billing cadence.
 *
 * Algorithm per vendor:
 *   1. Pull the last 10 approved invoice_date values (within lookback window).
 *   2. Compute intervals (days) between consecutive invoices.
 *   3. Take the median interval as the vendor's "expected cadence".
 *   4. Flag if: today − last_invoice_date  >  1.8 × median_interval
 *      AND median_interval ≤ 45 days  (ignore infrequent/one-off vendors)
 *      AND at least 3 bills in history (need a baseline).
 *   5. Write one finance_suggestion_log row per flagged vendor.
 *   6. Push-notify admin/accounts if any gaps found.
 *
 * Only processes vendors with ≥3 approved bills in the lookback window
 * so we never flag a new vendor.
 */

export async function GET(request: NextRequest) {
  // Auth: CRON_SECRET header
  const secret = request.headers.get("x-cron-secret") ?? request.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const config = await loadFinanceIntelligenceConfig(supabase);

  if (!isFeatureEnabled(config, "invoice_gap_audit")) {
    return NextResponse.json({ skipped: true, reason: "feature_disabled" });
  }

  const lookbackMonths = config.lookback_months;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - lookbackMonths);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const todayStr = new Date().toISOString().split("T")[0];

  // Pull all approved bills in the lookback window, ordered vendor + date
  const { data: bills, error } = await supabase
    .from("vendor_bills")
    .select("vendor_id, invoice_date, id, bill_number, procurement_vendors(name)")
    .eq("approval_status", "approved")
    .gte("invoice_date", cutoffStr)
    .order("vendor_id")
    .order("invoice_date", { ascending: true });

  if (error) {
    console.error("[gap-audit] fetch error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Group by vendor
  const byVendor = new Map<string, {
    name: string | null;
    bills: { id: string; bill_number: string; invoice_date: string }[];
  }>();

  for (const b of bills ?? []) {
    const vendorId = b.vendor_id as string;
    if (!byVendor.has(vendorId)) {
      const vendorRaw = b.procurement_vendors as unknown as { name: string } | { name: string }[] | null;
      const vendor = Array.isArray(vendorRaw) ? (vendorRaw[0] ?? null) : vendorRaw;
      byVendor.set(vendorId, { name: vendor?.name ?? null, bills: [] });
    }
    byVendor.get(vendorId)!.bills.push({
      id: b.id as string,
      bill_number: b.bill_number as string,
      invoice_date: b.invoice_date as string,
    });
  }

  type GapAlert = {
    vendor_id: string;
    vendor_name: string | null;
    last_bill_id: string;
    last_bill_number: string;
    last_invoice_date: string;
    days_since_last: number;
    median_interval: number;
    expected_by: string;      // date when next invoice was "due"
  };

  const gaps: GapAlert[] = [];

  for (const [vendorId, { name, bills: vBills }] of byVendor) {
    if (vBills.length < 3) continue; // need baseline

    // Intervals in days between consecutive invoices
    const intervals: number[] = [];
    for (let i = 1; i < vBills.length; i++) {
      const prev = new Date(vBills[i - 1].invoice_date);
      const curr = new Date(vBills[i].invoice_date);
      const diff = Math.round((curr.getTime() - prev.getTime()) / 86_400_000);
      if (diff > 0) intervals.push(diff);
    }
    if (!intervals.length) continue;

    const med = Math.round(median(intervals));
    if (med > 45) continue; // infrequent vendor — not a gap signal

    const lastBill = vBills[vBills.length - 1];
    const lastDate = new Date(lastBill.invoice_date);
    const today = new Date(todayStr);
    const daysSinceLast = Math.round(
      (today.getTime() - lastDate.getTime()) / 86_400_000,
    );

    if (daysSinceLast > Math.round(med * 1.8)) {
      const expectedBy = new Date(lastDate);
      expectedBy.setDate(expectedBy.getDate() + med);

      gaps.push({
        vendor_id: vendorId,
        vendor_name: name,
        last_bill_id: lastBill.id,
        last_bill_number: lastBill.bill_number,
        last_invoice_date: lastBill.invoice_date,
        days_since_last: daysSinceLast,
        median_interval: med,
        expected_by: expectedBy.toISOString().split("T")[0],
      });

      // Log each gap (fire-and-forget, non-blocking)
      logSuggestion(supabase, {
        feature: "invoice_gap_audit",
        entity_type: "vendor_bill",
        entity_id: lastBill.id,
        suggestion: {
          vendor_name: name,
          days_since_last: daysSinceLast,
          median_interval: med,
          expected_by: expectedBy.toISOString().split("T")[0],
        },
        context: {
          vendor_id: vendorId,
          last_invoice_date: lastBill.invoice_date,
          bill_count: vBills.length,
        },
      }).catch(() => {});
    }
  }

  // Push notification to admin/accounts if any gaps found
  if (gaps.length > 0) {
    const names = gaps
      .slice(0, 3)
      .map((g) => g.vendor_name ?? "Unknown")
      .join(", ");
    const more = gaps.length > 3 ? ` +${gaps.length - 3} more` : "";

    sendPushToAll({
      title: `${gaps.length} vendor invoice${gaps.length > 1 ? "s" : ""} overdue`,
      body: `${names}${more} haven't billed in longer than usual`,
      url: "/procurement/payables",
      tag: `invoice-gap-audit-${todayStr}`,
    }).catch((err) => console.error("[gap-audit] push failed:", err));
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    vendors_checked: byVendor.size,
    gaps_found: gaps.length,
    gaps,
  });
}

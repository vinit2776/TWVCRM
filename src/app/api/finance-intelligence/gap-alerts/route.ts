import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  loadFinanceIntelligenceConfig,
  isFeatureEnabled,
} from "@/lib/finance-intelligence";

/**
 * GET /api/finance-intelligence/gap-alerts
 *
 * Returns the most-recent invoice-gap suggestion log entries for display
 * on the Payables page. Reads from finance_suggestion_log where:
 *   - feature = 'invoice_gap_audit'
 *   - user_action IN ('shown', null)   — not yet dismissed by the user
 *   - triggered_at within the last 8 days  (fresh cron output only)
 *
 * The payables page calls this once on mount (lightweight — no heavy
 * DB computation here, the cron already did the work).
 */

export interface GapAlertItem {
  id: string;                 // finance_suggestion_log.id (for dismiss)
  vendor_id: string;
  vendor_name: string | null;
  last_bill_id: string;
  last_bill_number: string;
  last_invoice_date: string;
  days_since_last: number;
  median_interval: number;
  expected_by: string;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = await loadFinanceIntelligenceConfig(supabase);
  if (!isFeatureEnabled(config, "invoice_gap_audit")) {
    return NextResponse.json({ alerts: [] });
  }

  // Freshness window: last 8 days (covers Mon→Mon weekly cron with buffer)
  const since = new Date();
  since.setDate(since.getDate() - 8);

  const { data, error } = await supabase
    .from("finance_suggestion_log")
    .select("id, entity_id, suggestion, context, triggered_at")
    .eq("feature", "invoice_gap_audit")
    .in("user_action", ["shown"])
    .gte("triggered_at", since.toISOString())
    .order("triggered_at", { ascending: false })
    .limit(10);

  if (error) return NextResponse.json({ alerts: [] });

  // Deduplicate by vendor_id (keep most-recent per vendor)
  const seen = new Set<string>();
  const alerts: GapAlertItem[] = [];

  for (const row of data ?? []) {
    const ctx = row.context as Record<string, unknown> ?? {};
    const sug = row.suggestion as Record<string, unknown> ?? {};
    const vendorId = ctx.vendor_id as string;
    if (!vendorId || seen.has(vendorId)) continue;
    seen.add(vendorId);

    alerts.push({
      id: row.id,
      vendor_id: vendorId,
      vendor_name: (sug.vendor_name as string) ?? null,
      last_bill_id: (row.entity_id as string) ?? "",
      last_bill_number: "",   // enriched below
      last_invoice_date: ctx.last_invoice_date as string ?? "",
      days_since_last: sug.days_since_last as number ?? 0,
      median_interval: sug.median_interval as number ?? 0,
      expected_by: sug.expected_by as string ?? "",
    });
  }

  // Enrich with bill numbers in one batch query
  const billIds = alerts.map((a) => a.last_bill_id).filter(Boolean);
  if (billIds.length) {
    const { data: billRows } = await supabase
      .from("vendor_bills")
      .select("id, bill_number")
      .in("id", billIds);
    const billMap = new Map((billRows ?? []).map((b) => [b.id, b.bill_number]));
    for (const a of alerts) {
      a.last_bill_number = billMap.get(a.last_bill_id) ?? "";
    }
  }

  return NextResponse.json({ alerts });
}

/**
 * DELETE /api/finance-intelligence/gap-alerts?id=<log_id>
 * Marks an alert as dismissed so it won't show again.
 */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await supabase
    .from("finance_suggestion_log")
    .update({ user_action: "dismissed", resolved_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true });
}

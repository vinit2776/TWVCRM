import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/facility/assets/[id]/amc
 * Returns:
 *  - contracts: purchase_orders (po_type='service') with linked_asset_id matching this asset
 *  - events: ad-hoc service events (breakdown / preventive / annual) linked to this asset
 *  - service_reports: cycle-based service reports from any contract on this asset
 *
 * Events come from a dedicated asset_id column. Service reports don't have one
 * (they live per-PO with no asset link), so we resolve them via the contracts.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch AMC contracts linked to this asset
  const { data: contracts } = await supabase
    .from("purchase_orders")
    .select(`
      id, po_number, amc_status, amc_start_date, amc_end_date,
      amc_visits_covered, amc_visits_used,
      amc_contact_name, amc_helpline_number, amc_contact_email,
      amc_escalation_name, amc_escalation_phone,
      amc_escalation2_name, amc_escalation2_phone,
      amc_scope_covered, amc_scope_exclusions,
      amc_terminated_at, amc_termination_reason,
      total_ordered_amount, created_at, status,
      terminator:users!amc_terminated_by(id, full_name),
      procurement_vendors(id, name)
    `)
    .eq("linked_asset_id", assetId)
    .eq("po_type", "service")
    .order("amc_start_date", { ascending: false });

  // Fetch all service events linked to this asset (across all POs)
  const { data: events } = await supabase
    .from("amc_service_events")
    .select(`
      id, po_id, event_number, event_type, event_date,
      technician_name, issue_description, resolution_notes,
      next_scheduled_date, report_file_url, created_at,
      confirmed_at, confirmed_by, vendor_notes, vendor_submitted_at,
      logger:users!amc_service_events_logged_by_fkey(id, full_name),
      confirmer:users!amc_service_events_confirmed_by_fkey(id, full_name),
      checklist:amc_event_checklist_items(id, checked)
    `)
    .eq("asset_id", assetId)
    .order("event_date", { ascending: false })
    .limit(50);

  // Fetch cycle-based service reports from the linked contracts. po_service_reports
  // has no asset_id of its own, so we look up reports for every PO on this asset.
  const contractIds = (contracts ?? []).map((c) => c.id);
  let serviceReports: Array<{
    id: string;
    po_id: string;
    po_number?: string | null;
    cycle_number: number;
    period_from: string | null;
    period_to: string | null;
    report_file_url: string | null;
    notes: string | null;
    created_at: string;
    recorder?: { id: string; full_name?: string } | null;
  }> = [];
  if (contractIds.length > 0) {
    const { data: reports } = await supabase
      .from("po_service_reports")
      .select(`
        id, po_id, cycle_number, period_from, period_to,
        report_file_url, notes, created_at,
        recorder:users!po_service_reports_recorded_by_fkey(id, full_name)
      `)
      .in("po_id", contractIds)
      .order("period_from", { ascending: false })
      .limit(50);

    // Tag each report with its PO number for the timeline UI
    const poNumberById = new Map(
      (contracts ?? []).map((c) => [c.id, c.po_number])
    );
    serviceReports = (reports ?? []).map((r) => ({
      ...r,
      po_number: poNumberById.get(r.po_id) ?? null,
      recorder: Array.isArray(r.recorder) ? r.recorder[0] ?? null : r.recorder,
    }));
  }

  return NextResponse.json({
    contracts: contracts || [],
    events: events || [],
    service_reports: serviceReports,
  });
}

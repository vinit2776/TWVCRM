import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/facility/assets/[id]/amc
 * Returns AMC contracts (purchase_orders with linked_asset_id matching this asset)
 * and all service events linked to this asset.
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
      amc_scope_covered, amc_scope_exclusions,
      total_ordered_amount,
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

  return NextResponse.json({
    contracts: contracts || [],
    events: events || [],
  });
}

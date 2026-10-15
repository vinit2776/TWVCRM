import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { countsTowardVisits } from "@/lib/amc-lifecycle";
import { countedVisitsByAsset, combinedVisitsUsed } from "@/lib/procurement/amc-lines";
import { z } from "zod";

const createEventSchema = z.object({
  event_type: z.enum(["breakdown", "preventive", "remote_support", "annual_service"]),
  event_date: z.string().min(1, "Event date is required"),
  technician_name: z.string().optional(),
  issue_description: z.string().min(1, "Description is required"),
  resolution_notes: z.string().optional(),
  next_scheduled_date: z.string().optional(),
  report_file_url: z.string().url().optional().or(z.literal("")),
  asset_id: z.string().uuid().optional().nullable(),
});

/**
 * GET /api/procurement/amc/[id]/events
 * List all service events for an AMC PO
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: poId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Validate PO exists and is a service PO
  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, po_type, amc_visits_covered, amc_visits_used, amc_start_date, amc_end_date, amc_status")
    .eq("id", poId)
    .single();

  if (!po) return NextResponse.json({ error: "PO not found" }, { status: 404 });
  if (po.po_type !== "service") return NextResponse.json({ error: "Not a service PO" }, { status: 422 });

  const { data: events, error } = await supabase
    .from("amc_service_events")
    .select(`
      *,
      logger:users!amc_service_events_logged_by_fkey(id, full_name),
      confirmer:users!amc_service_events_confirmed_by_fkey(id, full_name),
      asset:facility_assets!amc_service_events_asset_id_fkey(id, name, asset_code),
      checklist:amc_event_checklist_items(id, checked)
    `)
    .eq("po_id", poId)
    .order("event_number", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: events ?? [], po });
}

/**
 * POST /api/procurement/amc/[id]/events
 * Log a new service event — increments amc_visits_used for preventive / annual service only
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: poId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Fetch PO to validate and get visit counts
  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, po_type, status, amc_visits_covered, amc_visits_used, amc_start_date, amc_status")
    .eq("id", poId)
    .single();

  if (!po) return NextResponse.json({ error: "PO not found" }, { status: 404 });
  if (po.po_type !== "service") return NextResponse.json({ error: "Not a service PO" }, { status: 422 });
  // A cancelled contract is no longer being serviced under this PO. The screens hide the
  // button already; this stops the API logging against it directly.
  if (po.status === "cancelled") {
    return NextResponse.json({ error: "This purchase order is cancelled, so visits can't be logged against it" }, { status: 422 });
  }

  const body = await request.json();
  const parsed = createEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const visitsUsed = Number(po.amc_visits_used ?? 0);
  const visitsCovered = po.amc_visits_covered != null ? Number(po.amc_visits_covered) : null;

  // Only scheduled service (preventive, annual) uses up a covered visit; a
  // breakdown or remote call is unlimited, so it never trips the limit.
  const countsAsVisit = countsTowardVisits(parsed.data.event_type);

  // A combined PO covers several assets and visits are counted per asset, so a
  // visit on one must say which asset it was for (and it must be one of them).
  const { data: coveredLines } = await supabase
    .from("purchase_order_items")
    .select("linked_asset_id")
    .eq("po_id", poId)
    .not("linked_asset_id", "is", null);
  const poAssetIds = Array.from(new Set((coveredLines ?? []).map((l) => l.linked_asset_id as string)));
  const isMultiAsset = poAssetIds.length > 1;
  if (isMultiAsset) {
    if (!parsed.data.asset_id) {
      return NextResponse.json({ error: "Choose which asset this visit was for" }, { status: 422 });
    }
    if (!poAssetIds.includes(parsed.data.asset_id)) {
      return NextResponse.json({ error: "That asset is not covered by this contract" }, { status: 422 });
    }
  }

  // Warn if at/over limit (but don't block — physical work may still happen)
  let atLimit = countsAsVisit && visitsCovered !== null && visitsUsed >= visitsCovered;

  // Determine next event_number for this PO
  const { count: existingCount } = await supabase
    .from("amc_service_events")
    .select("*", { count: "exact", head: true })
    .eq("po_id", poId);

  const nextEventNumber = (existingCount ?? 0) + 1;

  // Insert event
  const { data: event, error: insertError } = await supabase
    .from("amc_service_events")
    .insert({
      po_id: poId,
      event_number: nextEventNumber,
      event_type: parsed.data.event_type,
      event_date: parsed.data.event_date,
      technician_name: parsed.data.technician_name ?? null,
      issue_description: parsed.data.issue_description,
      resolution_notes: parsed.data.resolution_notes ?? null,
      next_scheduled_date: parsed.data.next_scheduled_date ?? null,
      report_file_url: parsed.data.report_file_url || null,
      asset_id: parsed.data.asset_id || null,
      logged_by: dbUser.id,
    })
    .select("id, event_number")
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  // Seed checklist from templates if the linked asset has a category
  if (parsed.data.asset_id) {
    try {
      const admin = createAdminClient();
      const { data: asset } = await admin
        .from("facility_assets")
        .select("category_id")
        .eq("id", parsed.data.asset_id)
        .single();

      if (asset?.category_id) {
        const { data: templates } = await admin
          .from("facility_checklist_templates")
          .select("label, sort_order")
          .eq("category_id", asset.category_id)
          .eq("is_active", true)
          .or(`event_type.is.null,event_type.eq.${parsed.data.event_type}`)
          .order("sort_order", { ascending: true });

        if (templates && templates.length > 0) {
          await admin.from("amc_event_checklist_items").insert(
            templates.map(t => ({
              event_id: event.id,
              label: t.label,
              checked: false,
              is_custom: false,
            }))
          );
        }
      }
    } catch {
      // Non-blocking — checklist seeding failure shouldn't block event creation
    }
  }

  // Increment visits_used on the PO — counted visit types only. On a combined PO the
  // figure is derived per asset instead (see combinedVisitsUsed).
  let newVisitsUsed = countsAsVisit ? visitsUsed + 1 : visitsUsed;
  if (isMultiAsset && countsAsVisit) {
    const { data: allEvents } = await supabase
      .from("amc_service_events")
      .select("asset_id, event_type")
      .eq("po_id", poId);
    const perAsset = countedVisitsByAsset(allEvents ?? [], poAssetIds);
    newVisitsUsed = combinedVisitsUsed(perAsset);
    // The event is already inserted, so "before this visit" is one less for its asset.
    atLimit = visitsCovered !== null && (perAsset[parsed.data.asset_id as string] ?? 0) - 1 >= visitsCovered;
  }
  if (countsAsVisit) {
    const newAmcStatus = computeAmcStatus(
      po.amc_start_date,
      null,                  // end date check happens in list API; no field here
      visitsCovered,
      newVisitsUsed,
      new Date()
    );

    await supabase
      .from("purchase_orders")
      .update({
        amc_visits_used: newVisitsUsed,
        amc_status: newAmcStatus,
      })
      .eq("id", poId);
  }

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: poId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      amc_event_logged: { old: null, new: `Event #${nextEventNumber}: ${parsed.data.event_type}` },
      ...(countsAsVisit && { amc_visits_used: { old: visitsUsed, new: newVisitsUsed } }),
    },
  });

  return NextResponse.json(
    {
      data: event,
      at_limit: atLimit,
      visits_used: newVisitsUsed,
      visits_covered: visitsCovered,
    },
    { status: 201 }
  );
}

function computeAmcStatus(
  startDate: string | null,
  endDate: string | null,
  visitsCovered: number | null,
  visitsUsed: number,
  today: Date
): string {
  if (!startDate) return "inactive";
  const start = new Date(startDate);
  if (today < start) return "inactive";
  if (endDate) {
    const end = new Date(endDate);
    if (today > end) return "expired";
    const daysLeft = Math.floor((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 60) return "expiring";
  }
  if (visitsCovered !== null && visitsUsed >= visitsCovered) return "exhausted";
  return "active";
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createEventSchema = z.object({
  event_type: z.enum(["breakdown", "preventive", "remote_support", "annual_service"]),
  event_date: z.string().min(1, "Event date is required"),
  technician_name: z.string().optional(),
  issue_description: z.string().min(1, "Description is required"),
  resolution_notes: z.string().optional(),
  next_scheduled_date: z.string().optional(),
  report_file_url: z.string().url().optional().or(z.literal("")),
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
      logger:users!amc_service_events_logged_by_fkey(id, full_name)
    `)
    .eq("po_id", poId)
    .order("event_number", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: events ?? [], po });
}

/**
 * POST /api/procurement/amc/[id]/events
 * Log a new service event — increments amc_visits_used
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
    .select("id, po_type, amc_visits_covered, amc_visits_used, amc_start_date, amc_status")
    .eq("id", poId)
    .single();

  if (!po) return NextResponse.json({ error: "PO not found" }, { status: 404 });
  if (po.po_type !== "service") return NextResponse.json({ error: "Not a service PO" }, { status: 422 });

  const body = await request.json();
  const parsed = createEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const visitsUsed = Number(po.amc_visits_used ?? 0);
  const visitsCovered = po.amc_visits_covered != null ? Number(po.amc_visits_covered) : null;

  // Warn if at/over limit (but don't block — physical work may still happen)
  const atLimit = visitsCovered !== null && visitsUsed >= visitsCovered;

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
      logged_by: dbUser.id,
    })
    .select("id, event_number")
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  // Increment visits_used on the PO
  const newVisitsUsed = visitsUsed + 1;
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

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: poId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      amc_event_logged: { old: null, new: `Event #${nextEventNumber}: ${parsed.data.event_type}` },
      amc_visits_used: { old: visitsUsed, new: newVisitsUsed },
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

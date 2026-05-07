/**
 * /api/lead-cautions
 *
 * Cautions are warnings/notes attached to a lead that surface as
 * banners on:
 *   - the lead profile (always)
 *   - the new-booking flow when staff types a phone matching the lead
 *     (with an explicit acknowledge gate for `danger` severity)
 *
 * GET   ?lead_id=...        list active cautions for a lead
 *       ?lead_id=...&include_dismissed=true  history
 * POST                      create a manual caution from the lead
 *                           profile (admin / manager / floor_manager)
 *
 * Cautions auto-created during the cancel flow are inserted directly
 * by /api/bookings/[id]/cancel, not via this endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const STAFF_ROLES = new Set(["admin", "manager", "floor_manager"]);

const CAUTION_SELECT = `
  *,
  creator:users!lead_cautions_created_by_fkey(id, full_name),
  booking:bookings!lead_cautions_booking_id_fkey(id, booking_number)
`;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const leadId = searchParams.get("lead_id")?.trim();
  const includeDismissed = searchParams.get("include_dismissed") === "true";

  if (!leadId) {
    return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
  }

  // Order: severity desc (danger > warning > info) so the most
  // serious caution surfaces first, then by created_at desc.
  let query = supabase
    .from("lead_cautions")
    .select(CAUTION_SELECT)
    .eq("lead_id", leadId)
    .order("severity", { ascending: false })   // danger sorts after warning lex; we'll sort severity client-side via mapping
    .order("created_at", { ascending: false });

  if (!includeDismissed) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Postgres enum text-sort doesn't match our preferred severity order
  // (danger > warning > info). Re-sort client-side. The order_by above
  // is a fallback for callers who don't care about severity order.
  const severityRank: Record<string, number> = { danger: 0, warning: 1, info: 2 };
  const sorted = (data || []).slice().sort((a, b) => {
    const sa = severityRank[a.severity] ?? 3;
    const sb = severityRank[b.severity] ?? 3;
    if (sa !== sb) return sa - sb;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return NextResponse.json({ data: sorted });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !STAFF_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Floor manager / manager / admin access required" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const leadId = body.lead_id as string | undefined;
  const note = (body.note as string | undefined)?.trim();
  const severity = body.severity as "info" | "warning" | "danger" | undefined;
  const bookingId = body.booking_id as string | undefined;

  if (!leadId) return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
  if (!note)   return NextResponse.json({ error: "note is required" },    { status: 400 });
  if (!severity || !["info", "warning", "danger"].includes(severity)) {
    return NextResponse.json({ error: "severity must be info, warning, or danger" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("lead_cautions")
    .insert({
      lead_id: leadId,
      booking_id: bookingId || null,
      note,
      severity,
      created_by: dbUser.id,
    })
    .select(CAUTION_SELECT)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Failed to create caution" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "lead_caution",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      lead_id: { old: null, new: leadId },
      severity: { old: null, new: severity },
      note: { old: null, new: note },
    },
  });

  return NextResponse.json({ data }, { status: 201 });
}

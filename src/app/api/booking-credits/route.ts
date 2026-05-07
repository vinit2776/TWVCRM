/**
 * /api/booking-credits
 *
 * GET   — search active credits for a phone (+ optional location filter).
 *         Used by the new-booking flow ("does this phone have unredeemed
 *         credit at this centre?") and the lead profile credits card.
 *
 * POST  — manual credit issuance from the lead profile, used for goodwill
 *         situations that aren't tied to a partial-checkout (the partial
 *         checkout has its own atomic endpoint at /bookings/[id]/defer).
 *         Floor manager+ only.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const STAFF_ROLES = new Set(["admin", "manager", "floor_manager"]);

const CREDIT_SELECT = `
  *,
  location:locations!booking_credits_location_id_fkey(id, name, code),
  lead:leads!booking_credits_lead_id_fkey(id, first_name, last_name, company),
  issued_from_booking:bookings!booking_credits_issued_from_booking_id_fkey(id, booking_number)
`;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const phone = searchParams.get("phone")?.trim();
  const locationId = searchParams.get("location_id")?.trim();
  const leadId = searchParams.get("lead_id")?.trim();
  const includeUsed = searchParams.get("include_used") === "true";

  if (!phone && !leadId) {
    return NextResponse.json(
      { error: "phone or lead_id is required" },
      { status: 400 }
    );
  }

  let query = supabase
    .from("booking_credits")
    .select(CREDIT_SELECT)
    .order("issued_at", { ascending: false });

  if (phone) query = query.eq("phone", phone);
  if (leadId) query = query.eq("lead_id", leadId);
  if (locationId) query = query.eq("location_id", locationId);
  if (!includeUsed) {
    // Default = only active credits with hours remaining + not expired.
    // The expiry check belongs in code (rather than a generated column)
    // because credits transition to `expired` only when something looks
    // at them — there's no cron sweeping expiries. Callers that need to
    // see the exhausted/expired ones (lead profile history, audit) pass
    // include_used=true.
    query = query.eq("status", "active").gt("expires_at", new Date().toISOString());
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Compute hours_remaining client-side rather than pulling from a view —
  // it's a single subtraction and keeps the schema simple.
  const enriched = (data || []).map((c) => ({
    ...c,
    hours_remaining: Math.max(0, Number(c.hours_total) - Number(c.hours_used)),
  }));

  return NextResponse.json({ data: enriched });
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
  const phone = (body.phone as string | undefined)?.trim();
  const locationId = body.location_id as string | undefined;
  const leadId = (body.lead_id as string | undefined) || null;
  const hours = Number(body.hours_total);
  const hourlyRate = Number(body.hourly_rate_snapshot);
  const expiresAtBody = body.expires_at as string | undefined;
  const notes = (body.notes as string | undefined)?.trim() || null;

  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 });
  if (!locationId) return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  if (!Number.isFinite(hours) || hours < 1 || !Number.isInteger(hours)) {
    return NextResponse.json({ error: "hours_total must be a whole number ≥ 1" }, { status: 400 });
  }
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
    return NextResponse.json({ error: "hourly_rate_snapshot must be a positive number" }, { status: 400 });
  }

  const issuedAt = new Date();
  const expiresAt = expiresAtBody
    ? new Date(expiresAtBody)
    : new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (isNaN(expiresAt.getTime()) || expiresAt <= issuedAt) {
    return NextResponse.json({ error: "expires_at must be a future ISO date" }, { status: 400 });
  }

  const { data: credit, error } = await supabase
    .from("booking_credits")
    .insert({
      phone,
      location_id: locationId,
      lead_id: leadId,
      hours_total: hours,
      hourly_rate_snapshot: hourlyRate,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active",
      notes,
      issued_by: dbUser.id,
    })
    .select(CREDIT_SELECT)
    .single();

  if (error || !credit) {
    return NextResponse.json({ error: error?.message ?? "Failed to issue credit" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "booking_credit",
    entityId: credit.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      hours_total: { old: null, new: hours },
      phone: { old: null, new: phone },
      location_id: { old: null, new: locationId },
      reason: { old: null, new: notes ?? "Manual issue from lead profile" },
    },
  });

  return NextResponse.json({ data: credit }, { status: 201 });
}

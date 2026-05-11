/**
 * GET /api/refund-requests
 *
 * Finance / approval queue list for refund requests created by the
 * cancellation flow. Supports `?status=` filter (pending_approval,
 * approved, rejected, processed) and `?booking_id=` to find a request
 * for a specific booking.
 *
 * Rows include the source booking + customer for context — the
 * approver/processor needs to see who they're refunding without
 * round-tripping.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SELECT = `
  *,
  booking:bookings!refund_requests_booking_id_fkey(
    id, booking_number, booking_date, total_amount, total_amount_with_gst,
    customer_type, lead_id, guest_name, guest_phone, booker_phone,
    location:locations!bookings_location_id_fkey(id, name, code),
    lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company)
  ),
  requester:users!refund_requests_requested_by_fkey(id, full_name),
  approver:users!refund_requests_approved_by_fkey(id, full_name),
  rejector:users!refund_requests_rejected_by_fkey(id, full_name),
  processor:users!refund_requests_processed_by_fkey(id, full_name)
`;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const bookingId = searchParams.get("booking_id");

  let query = supabase
    .from("refund_requests")
    .select(SELECT)
    .order("requested_at", { ascending: false });

  if (status) {
    // Allow comma-separated list (e.g., "approved,pending_approval")
    const parts = status.split(",").map((s) => s.trim()).filter(Boolean);
    query = parts.length > 1 ? query.in("status", parts) : query.eq("status", parts[0]);
  }
  if (bookingId) query = query.eq("booking_id", bookingId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

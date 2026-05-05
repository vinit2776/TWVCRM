import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/vouchers/[id]/issuance
 *
 * Returns the active issuance for this voucher (if any) joined with the
 * lead, contract, booking, and the user who issued it. Used by the
 * voucher-detail side panel on /vouchers when admin clicks an "Issued" row.
 *
 * Inactive issuances (replaced / revoked) are also returned, ordered most-
 * recent first, so the panel can show a short history when a voucher has
 * been re-issued.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // First pull the voucher itself so we can render the dialog header even
  // when no issuance exists (defensive — e.g. status=available was clicked).
  const { data: voucher, error: vErr } = await supabase
    .from("voucher_repository")
    .select("id, voucher_code, status, validity_days, issued_at, location_id, location:locations!voucher_repository_location_id_fkey(id, name, code)")
    .eq("id", id)
    .single();
  if (vErr || !voucher) {
    return NextResponse.json({ error: "Voucher not found" }, { status: 404 });
  }

  // All issuances for this voucher (typically one active, possibly past
  // replacements). Ordered most recent first.
  const { data: issuances, error: iErr } = await supabase
    .from("voucher_issuances")
    .select(`
      id, voucher_id, contract_id, booking_id, lead_id,
      seat_number, seat_occupant_email, emailed_at,
      issued_at, valid_from, valid_until,
      revoked_at, revoke_reason, is_active, replaces_issuance_id,
      issuer:users!voucher_issuances_issued_by_fkey(id, full_name),
      lead:leads!voucher_issuances_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile),
      contract:contracts!voucher_issuances_contract_id_fkey(id, contract_number, status),
      booking:bookings!voucher_issuances_booking_id_fkey(id, booking_number, booking_date, start_time, end_time, status, customer_type, guest_name)
    `)
    .eq("voucher_id", id)
    .order("issued_at", { ascending: false });

  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });

  return NextResponse.json({
    data: {
      voucher,
      issuances: issuances ?? [],
    },
  });
}

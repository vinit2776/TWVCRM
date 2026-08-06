import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/pending-overtime-charges
 * Surfaces contract-holder conference-room overtime charges (posted at
 * checkout when a member stays past the booked end time) that are still
 * pending — i.e. not yet waived or billed.
 *
 * Access: admin, manager. This is a waive/review queue, not a general
 * billing report — staff who can create charges (floor_manager, etc.)
 * intentionally cannot waive them, so they don't see this queue either.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await adminSupabase
    .from("usage_charges")
    .select(
      "id, total_with_gst, charge_date, booking_id, " +
      "contract:contracts!usage_charges_contract_id_fkey(contract_number), " +
      "lead:leads!usage_charges_lead_id_fkey(first_name, last_name, company), " +
      "booking:bookings!usage_charges_booking_id_fkey(booking_number)"
    )
    .eq("booking_charge_kind", "overtime")
    .eq("status", "pending")
    .order("charge_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    id: string;
    total_with_gst: number | null;
    booking_id: string | null;
    contract: { contract_number: string | null } | null;
    lead: { first_name: string; last_name: string; company: string | null } | null;
    booking: { booking_number: string | null } | null;
  };

  const rows = (data ?? []) as unknown as Row[];

  const items = rows.slice(0, 8).map((r) => ({
    id: r.id,
    contract_number: r.contract?.contract_number ?? "—",
    customer: r.lead
      ? `${r.lead.first_name} ${r.lead.last_name}${r.lead.company ? " · " + r.lead.company : ""}`
      : "Unknown",
    booking_number: r.booking?.booking_number ?? "—",
    booking_id: r.booking_id,
    amount: Math.round(Number(r.total_with_gst ?? 0)),
  }));

  const totalPendingValue = rows.reduce((s, r) => s + Number(r.total_with_gst ?? 0), 0);

  return NextResponse.json({
    data: {
      total_pending_value: Math.round(totalPendingValue),
      total_records: rows.length,
      items,
    },
  });
}

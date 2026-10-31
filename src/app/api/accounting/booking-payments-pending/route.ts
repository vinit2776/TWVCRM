import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canReviewPaymentReport } from "@/lib/queries/payment-reports";

/**
 * GET /api/accounting/booking-payments-pending — UPI payments reported against
 * a booking that accounts haven't checked against the bank yet.
 *
 * Feeds the Tally Inbox "To verify" tab. Verify / reject goes through the
 * existing PATCH /api/booking-payments/[id]; nothing is written here.
 * Razorpay rows are left out: their webhook flips them to verified on its own.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser || !canReviewPaymentReport(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("booking_payments")
    .select(
      `id, booking_id, amount, payment_mode, payment_reference, screenshot_path, created_at, created_by,
       booking:bookings(
         booking_number, booking_date, guest_name,
         lead:leads!bookings_lead_id_fkey(first_name, last_name, company)
       )`,
    )
    .eq("status", "pending")
    .eq("payment_mode", "upi")
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    id: string;
    booking_id: string;
    amount: number | string;
    payment_mode: string;
    payment_reference: string | null;
    screenshot_path: string | null;
    created_at: string;
    created_by: string | null;
    booking:
      | {
          booking_number: string | null;
          booking_date: string | null;
          guest_name: string | null;
          lead: { first_name: string | null; last_name: string | null; company: string | null } | { first_name: string | null; last_name: string | null; company: string | null }[] | null;
        }
      | null;
  };

  const rows = (data ?? []) as unknown as Row[];
  const creatorIds = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
  const creators = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", creatorIds);
    for (const u of users ?? []) creators.set(u.id as string, (u.full_name as string | null) ?? "");
  }

  const items = rows.map((r) => {
    const lead = Array.isArray(r.booking?.lead) ? r.booking?.lead[0] : r.booking?.lead;
    const leadName = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ");
    return {
      id: r.id,
      booking_id: r.booking_id,
      booking_number: r.booking?.booking_number ?? null,
      booking_date: r.booking?.booking_date ?? null,
      customer: r.booking?.guest_name || lead?.company || leadName || "Unknown customer",
      amount: Number(r.amount),
      payment_reference: r.payment_reference,
      screenshot_path: r.screenshot_path,
      created_at: r.created_at,
      reported_by: r.created_by ? creators.get(r.created_by) || null : null,
    };
  });

  return NextResponse.json({ items });
}

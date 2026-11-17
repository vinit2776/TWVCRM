import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canReviewPaymentReport } from "@/lib/queries/payment-reports";

/**
 * GET /api/accounting/booking-payments-pending — pending UPI booking payments
 * that have NO open verification report, so they would otherwise be invisible
 * to accounts (the To verify list is built from reports).
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
         booking_number, booking_date, guest_name, guest_company,
         total_amount, total_amount_with_gst,
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
          guest_company: string | null;
          total_amount: number | string | null;
          total_amount_with_gst: number | string | null;
          lead: { first_name: string | null; last_name: string | null; company: string | null } | { first_name: string | null; last_name: string | null; company: string | null }[] | null;
        }
      | null;
  };

  // A payment recorded since 00640 already has an open report and shows in the
  // reports list; this endpoint is for the ones that slipped past it (recorded
  // before reports existed), so they are not listed twice.
  const allRows = (data ?? []) as unknown as Row[];
  const reported = new Set<string>();
  if (allRows.length > 0) {
    const { data: open } = await supabase
      .from("query_payment_reports")
      .select("booking_payment_id")
      .eq("status", "reported")
      .in("booking_payment_id", allRows.map((r) => r.id));
    for (const r of open ?? []) reported.add(r.booking_payment_id as string);
  }
  const rows = allRows.filter((r) => !reported.has(r.id));
  const creatorIds = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
  const creators = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", creatorIds);
    for (const u of users ?? []) creators.set(u.id as string, (u.full_name as string | null) ?? "");
  }

  // Every other live payment on the same bookings: two pending rows for one
  // transfer is the usual shape of the old double-entry (before 00640 refused
  // it), and accounts need to see that to know which one to reject.
  const siblings = new Map<string, { id: string; amount: number; status: string }[]>();
  if (rows.length > 0) {
    const { data: others } = await supabase
      .from("booking_payments")
      .select("id, booking_id, amount, status")
      .in("booking_id", [...new Set(rows.map((r) => r.booking_id))])
      .in("status", ["pending", "verified"]);
    for (const o of others ?? []) {
      const list = siblings.get(o.booking_id as string) ?? [];
      list.push({ id: o.id as string, amount: Number(o.amount), status: o.status as string });
      siblings.set(o.booking_id as string, list);
    }
  }

  const items = rows.map((r) => {
    const lead = Array.isArray(r.booking?.lead) ? r.booking?.lead[0] : r.booking?.lead;
    const leadName = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ");
    const total = Number(r.booking?.total_amount_with_gst) || Number(r.booking?.total_amount) || 0;
    const others = (siblings.get(r.booking_id) ?? []).filter((o) => o.id !== r.id);
    return {
      id: r.id,
      booking_id: r.booking_id,
      booking_number: r.booking?.booking_number ?? null,
      booking_date: r.booking?.booking_date ?? null,
      // Same order the booking page uses, so the name matches what accounts see
      // when they open the booking.
      customer: leadName || r.booking?.guest_company || r.booking?.guest_name || lead?.company || "Unknown customer",
      booking_total: total,
      other_payments: others.map((o) => ({ amount: o.amount, status: o.status })),
      amount: Number(r.amount),
      payment_reference: r.payment_reference,
      screenshot_path: r.screenshot_path,
      created_at: r.created_at,
      reported_by: r.created_by ? creators.get(r.created_by) || null : null,
    };
  });

  return NextResponse.json({ items });
}

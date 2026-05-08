import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — List cash handovers from both contract_payments and booking_payments
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status"); // pending_handover or handed_over
  const year = parseInt(searchParams.get("year") || new Date().getFullYear().toString());
  const month = parseInt(searchParams.get("month") || (new Date().getMonth() + 1).toString());

  const periodStart = new Date(year, month - 1, 1).toISOString().split("T")[0];
  const periodEnd = new Date(year, month, 0).toISOString().split("T")[0];

  // Contract cash payments
  let contractQuery = supabase
    .from("contract_payments")
    .select(
      "id, payment_number, amount, payment_date, payment_mode, cash_handover_status, collected_by, collected_at, handed_over_to, handed_over_at, handover_confirmed_by, handover_confirmed_at, handover_notes, contract:contracts!contract_payments_contract_id_fkey(id, contract_number, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)), collector:users!contract_payments_collected_by_fkey(id, full_name), handover_receiver:users!contract_payments_handed_over_to_fkey(id, full_name)"
    )
    .eq("payment_mode", "cash")
    .not("cash_handover_status", "is", null)
    .gte("payment_date", periodStart)
    .lte("payment_date", periodEnd);

  if (status) {
    contractQuery = contractQuery.eq("cash_handover_status", status);
  }

  const { data: contractCash, error: contractError } = await contractQuery.order("collected_at", { ascending: false });

  if (contractError) return NextResponse.json({ error: contractError.message }, { status: 500 });

  // Booking cash payments
  let bookingQuery = supabase
    .from("booking_payments")
    .select(
      "id, amount, payment_mode, cash_handover_status, collected_by, collected_at, handed_over_to, handed_over_at, handover_confirmed_by, handover_confirmed_at, handover_notes, created_at, booking:bookings!booking_payments_booking_id_fkey(id, booking_number, booking_date, guest_name, guest_company, space:spaces!bookings_space_id_fkey(id, name), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company)), collector:users!booking_payments_collected_by_fkey(id, full_name)"
    )
    .eq("payment_mode", "cash")
    .not("cash_handover_status", "is", null)
    .gte("created_at", `${periodStart}T00:00:00`)
    .lte("created_at", `${periodEnd}T23:59:59`);

  if (status) {
    bookingQuery = bookingQuery.eq("cash_handover_status", status);
  }

  const { data: bookingCash, error: bookingError } = await bookingQuery.order("collected_at", { ascending: false });

  if (bookingError) return NextResponse.json({ error: bookingError.message }, { status: 500 });

  // Combine and compute totals
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contractItems = (contractCash || []).map((item: any) => ({
    ...item,
    source: "contract" as const,
    display_name: item.contract?.lead?.company || `${item.contract?.lead?.first_name || ""} ${item.contract?.lead?.last_name || ""}`.trim(),
    reference: item.payment_number || item.contract?.contract_number,
    // Expose link target — finance can click through to the contract
    // payment context.
    link_target_id: item.contract?.id ?? null,
    link_target_label: item.contract?.contract_number ?? null,
    link_target_type: "contract" as const,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookingItems = (bookingCash || []).map((item: any) => ({
    ...item,
    source: "booking" as const,
    display_name: item.booking?.guest_company || item.booking?.guest_name || item.booking?.lead?.company || `${item.booking?.lead?.first_name || ""} ${item.booking?.lead?.last_name || ""}`.trim(),
    reference: item.booking?.space?.name || "Walk-in",
    // Expose link target — finance can click through to the booking
    // detail (transaction) view.
    link_target_id: item.booking?.id ?? null,
    link_target_label: item.booking?.booking_number ?? null,
    link_target_type: "booking" as const,
  }));

  const allItems = [...contractItems, ...bookingItems].sort(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a: any, b: any) => new Date(b.collected_at || b.created_at || "").getTime() - new Date(a.collected_at || a.created_at || "").getTime()
  );

  const pendingTotal = allItems
    .filter((i: { cash_handover_status: string }) => i.cash_handover_status === "pending_handover")
    .reduce((s: number, i: { amount: number }) => s + Number(i.amount), 0);

  const handedOverTotal = allItems
    .filter((i: { cash_handover_status: string }) => i.cash_handover_status === "handed_over")
    .reduce((s: number, i: { amount: number }) => s + Number(i.amount), 0);

  return NextResponse.json({
    data: allItems,
    totals: {
      pending_handover: pendingTotal,
      handed_over: handedOverTotal,
      total: pendingTotal + handedOverTotal,
    },
  });
}

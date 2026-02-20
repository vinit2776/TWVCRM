import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — Generate booking receipt data (PDF generation happens client-side with jsPDF)
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("*, space:spaces!bookings_space_id_fkey(id, name, capacity), location:locations!bookings_location_id_fkey(id, name, address, city, state), contract:contracts!bookings_contract_id_fkey(id, contract_number), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email, phone), facilities:booking_facilities(*)")
    .eq("id", id)
    .single();

  if (error || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Fetch payments
  const { data: payments } = await supabase
    .from("booking_payments")
    .select("*")
    .eq("booking_id", id)
    .eq("status", "verified");

  // Fetch voucher
  let voucherCode: string | null = null;
  const { data: issuances } = await supabase
    .from("voucher_issuances")
    .select("voucher:voucher_repository!voucher_issuances_voucher_id_fkey(voucher_code)")
    .eq("booking_id", id)
    .eq("is_active", true)
    .limit(1);

  if (issuances?.[0]?.voucher) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = issuances[0].voucher as any;
    voucherCode = v.voucher_code;
  }

  return NextResponse.json({
    data: {
      booking,
      payments: payments || [],
      voucher_code: voucherCode,
      company: {
        name: "SREE DESIGN INFRASTRUCTURE PVT LTD",
        brand: "The WorkVilla",
        address: "Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034",
        phone: "+91 97910 97900",
        gst: "33AAACU4245J1ZF",
        website: "www.theworkvilla.com",
      },
    },
  });
}

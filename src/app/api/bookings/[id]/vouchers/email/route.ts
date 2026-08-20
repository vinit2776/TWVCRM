/**
 * POST /api/bookings/[id]/vouchers/email
 *
 * Emails the booking's active WiFi voucher code(s) to the customer.
 *
 * Bookings never had a delivery step for on-demand vouchers (see
 * src/app/api/bookings/[id]/vouchers/route.ts) — codes were only shown
 * once in a toast on the staff UI. This mirrors the contracts voucher
 * email flow (src/app/api/contracts/[id]/vouchers/email/route.ts).
 *
 * The actual send/resolve/audit logic lives in src/lib/booking-vouchers.ts
 * and is shared with the automatic send that now fires right after
 * POST /api/bookings/[id]/vouchers issues new codes — this route stays as
 * the manual "Send to customer" resend button on the booking detail page.
 *
 * WhatsApp delivery is intentionally out of scope — there is no
 * MSG91-approved template for WiFi vouchers (see src/lib/whatsapp.ts
 * `messaging` and the commented-out call in
 * src/lib/provision-booking-access.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { sendBookingVoucherEmail } from "@/lib/booking-vouchers";

const bodySchema = z.object({
  email: z.string().email().nullish(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  const senderName = dbUser?.full_name || "TWV Team";

  const rawBody = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { email: emailOverride } = parsed.data;

  const result = await sendBookingVoucherEmail(supabase, {
    bookingId: id,
    senderName,
    performedBy: dbUser?.id || null,
    emailOverride,
  });

  if (!result.ok) {
    const status = result.reason === "Booking not found" ? 404 : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }

  return NextResponse.json({
    message: `Voucher${result.sent !== 1 ? "s" : ""} emailed to ${result.recipient}`,
    emailed_at: result.emailedAt,
    sent: result.sent,
  });
}

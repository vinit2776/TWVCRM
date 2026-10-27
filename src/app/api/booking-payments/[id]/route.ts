import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { settleBookingPayment } from "@/lib/booking-payment-server";

// PATCH — verify or reject a payment (UPI screenshot verification).
// The same settle step backs the Tally Inbox "To verify" card, so both entry
// points close the report thread and apply the over-credit guard identically.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!["admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin", "coordinator"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const { status, verification_notes } = body;

  if (!status || !["verified", "rejected"].includes(status)) {
    return NextResponse.json({ error: "Status must be 'verified' or 'rejected'" }, { status: 400 });
  }

  const result = await settleBookingPayment(createAdminClient(), {
    paymentId: id,
    outcome: status,
    notes: typeof verification_notes === "string" ? verification_notes : null,
    reviewer: dbUser as { id: string; role: string; full_name: string },
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.payment });
}

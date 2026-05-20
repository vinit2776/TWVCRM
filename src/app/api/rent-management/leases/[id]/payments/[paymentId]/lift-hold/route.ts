import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// Admin-only: lifts a hold, returning the payment to pending for re-approval.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin")
    return NextResponse.json({ error: "Only admin can lift a hold" }, { status: 403 });

  await request.json().catch(() => ({}));

  const { data: payment } = await supabase
    .from("lease_payments")
    .select("status")
    .eq("id", paymentId)
    .single();

  if (!payment)                      return NextResponse.json({ error: "Payment not found" },          { status: 404 });
  if (payment.status !== "on_hold")  return NextResponse.json({ error: "Payment is not on hold" },     { status: 409 });

  const { data, error } = await supabase
    .from("lease_payments")
    .update({ status: "pending", on_hold_reason: null })
    .eq("id", paymentId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, {
    entityType: "lease_payment",
    entityId: paymentId,
    action: "update",
    performedBy: dbUser.id,
    changes: { status: { old: "on_hold", new: "pending" } },
  });
  return NextResponse.json({ data });
}

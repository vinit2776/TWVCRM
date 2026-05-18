import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const approveSchema = z.object({
  paid_date: z.string().optional(),
  payment_mode: z.enum(["bank_transfer", "cheque", "neft", "rtgs", "upi"]).optional(),
  payment_reference: z.string().nullish(),
  bank_account_id: z.string().uuid().nullish(),
  net_amount_paid: z.number().min(0).optional(),
  attachment_url: z.string().url().nullish(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data: payment } = await supabase.from("lease_payments").select("status, gross_rent_amount, tds_amount").eq("id", paymentId).single();
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (payment.status === "paid") return NextResponse.json({ error: "Payment already approved" }, { status: 409 });

  const netPaid = parsed.data.net_amount_paid ?? (payment.gross_rent_amount - payment.tds_amount);

  const { data, error } = await supabase
    .from("lease_payments")
    .update({
      status: "paid",
      approved_by: dbUser.id,
      approved_at: new Date().toISOString(),
      paid_date: parsed.data.paid_date || new Date().toISOString().split("T")[0],
      payment_mode: parsed.data.payment_mode,
      payment_reference: parsed.data.payment_reference,
      bank_account_id: parsed.data.bank_account_id,
      net_amount_paid: netPaid,
      attachment_url: parsed.data.attachment_url,
      on_hold_reason: null,
    })
    .eq("id", paymentId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_payment", entityId: paymentId, action: "update", performedBy: dbUser.id, changes: { status: { old: payment.status, new: "paid" } } });
  return NextResponse.json({ data });
}

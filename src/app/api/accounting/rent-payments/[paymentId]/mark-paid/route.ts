import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const schema = z.object({
  paid_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_mode:      z.enum(["bank_transfer", "neft", "rtgs", "imps", "cheque", "upi"]),
  payment_reference: z.string().min(1, "UTR / reference number required"),
  bank_account_id:   z.string().uuid().nullish(),
  net_amount_paid:   z.number().min(0).optional(),
  notes:             z.string().nullish(),
});

// Accounts + admin: records the actual bank transfer on an approved payment.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> }
) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data: payment } = await supabase
    .from("lease_payments")
    .select("status, gross_rent_amount, tds_amount")
    .eq("id", paymentId)
    .single();

  if (!payment)                       return NextResponse.json({ error: "Payment not found" },         { status: 404 });
  if (payment.status === "paid")      return NextResponse.json({ error: "Already paid" },              { status: 409 });
  if (payment.status !== "approved")  return NextResponse.json({ error: "Payment must be approved by admin first" }, { status: 422 });

  const netPaid = parsed.data.net_amount_paid ?? (payment.gross_rent_amount - payment.tds_amount);

  const { data, error } = await supabase
    .from("lease_payments")
    .update({
      status: "paid",
      paid_date: parsed.data.paid_date,
      payment_mode: parsed.data.payment_mode,
      payment_reference: parsed.data.payment_reference,
      bank_account_id: parsed.data.bank_account_id ?? null,
      net_amount_paid: netPaid,
      approved_by: dbUser.id,   // accounts person who processed
      approved_at: new Date().toISOString(),
    })
    .eq("id", paymentId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "lease_payment",
    entityId: paymentId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "approved", new: "paid" },
      payment_reference: { old: null, new: parsed.data.payment_reference },
    },
  });

  return NextResponse.json({ data });
}

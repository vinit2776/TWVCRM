import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { z } from "zod";

const patchBillSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("record_payment"),
    amount: z.number().positive("Payment amount must be greater than 0"),
    payment_mode: z.enum(["cash", "upi", "bank_transfer"]),
    payment_reference: z.string().nullish(),
    payment_date: z.string().nullish(),
  }),
]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(
      `*, procurement_vendors(id, name, contact_name, contact_phone), purchase_orders(id, po_number, status)`
    )
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only managers and admins can record payments" }, { status: 403 });
  }

  const { data: bill, error: fetchError } = await supabase
    .from("vendor_bills")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  const body = await request.json();
  const parsed = patchBillSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  let updatePayload: Record<string, unknown> = {};

  switch (parsed.data.action) {
    case "record_payment": {
      if (bill.payment_status === "paid") {
        return NextResponse.json({ error: "This bill is already fully paid" }, { status: 422 });
      }

      const newAmountPaid = Number(bill.amount_paid) + parsed.data.amount;
      const paymentStatus =
        newAmountPaid >= Number(bill.total_amount)
          ? "paid"
          : newAmountPaid > 0
          ? "partially_paid"
          : "unpaid";

      const today = new Date().toISOString().split("T")[0];

      updatePayload = {
        amount_paid: newAmountPaid,
        payment_status: paymentStatus,
        payment_mode: parsed.data.payment_mode,
        payment_reference: parsed.data.payment_reference ?? null,
        payment_date: parsed.data.payment_date ?? today,
      };
      break;
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("vendor_bills")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(bill as Record<string, unknown>, { ...bill, ...updatePayload } as Record<string, unknown>),
  });

  return NextResponse.json({ data: updated });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";

const updatePaymentSchema = z.object({
  paid_date: z.string().nullish(),
  payment_mode: z.enum(["bank_transfer", "cheque", "neft", "rtgs", "upi"]).nullish(),
  payment_reference: z.string().nullish(),
  bank_account_id: z.string().uuid().nullish(),
  attachment_url: z.string().url().nullish(),
  notes: z.string().nullish(),
  net_amount_paid: z.number().min(0).nullish(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Viewers can't mutate
  if (dbUser.role === "viewer")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = updatePaymentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from("lease_payments")
    .update(parsed.data)
    .eq("id", paymentId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_payment", entityId: paymentId, action: "update", performedBy: dbUser.id });
  return NextResponse.json({ data });
}

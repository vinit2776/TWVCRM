import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { chainLockedResponse } from "@/lib/procurement/chain-lock";
import { canRollback, rollbackReasonSchema } from "@/lib/procurement/admin-rollback";

const bodySchema = z.object({ reason: rollbackReasonSchema });

/**
 * POST /api/procurement/bills/[id]/unwind-credit
 *
 * Admin only. Takes back the part of a bill's paid amount that has no payment line behind it
 * (the old advance pre-credit), so a bill that was marked paid only because an advance was
 * credited to it stops reading as paid. Payments Accounts recorded are never touched.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!canRollback(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin can take back an advance credit" }, { status: 403 });
  }

  const lockedChain = await chainLockedResponse(supabase, { billId: id });
  if (lockedChain) return lockedChain;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A reason is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("unwind_bill_advance_credit", {
    p_bill_id: id,
    p_actor: dbUser.id,
    p_reason: parsed.data.reason,
  });
  if (error) {
    if (error.message.includes("NO_CREDIT")) {
      return NextResponse.json({ error: "This bill has no unrecorded credit to take back." }, { status: 422 });
    }
    if (error.message.includes("BILL_NOT_FOUND")) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
    console.error("[unwind-credit] rpc failed:", error.message);
    return NextResponse.json({ error: "Could not take back the credit" }, { status: 500 });
  }

  const result = data as { credit_removed: number; amount_paid: number; payment_status: string; previous: { amount_paid: number; payment_status: string } };
  await logAudit(admin, {
    entityType: "vendor_bill",
    entityId: id,
    action: "rollback",
    performedBy: dbUser.id,
    changes: {
      advance_credit_removed: { old: result.credit_removed, new: 0 },
      amount_paid: { old: result.previous.amount_paid, new: result.amount_paid },
      payment_status: { old: result.previous.payment_status, new: result.payment_status },
      reason: { old: null, new: parsed.data.reason },
    },
  });
  return NextResponse.json({ data: result });
}

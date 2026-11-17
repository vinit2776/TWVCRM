import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { chainLockedResponse } from "@/lib/procurement/chain-lock";
import { APPLY_ADVANCE_ERRORS, loadAdvanceUsage } from "@/lib/procurement/po-advance";

const bodySchema = z.object({ amount: z.number().positive("Enter an amount above zero") });

/**
 * POST /api/procurement/bills/[id]/apply-advance
 *
 * Applies part of the PO's paid advance to this bill as a payment line. Accounts or admin only:
 * it is a payment decision, made after looking at the invoice and its GST. All the checks and
 * both writes happen inside apply_po_advance (migration 00721) under row locks.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["accounts", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only Accounts or Admin can apply an advance to a bill" }, { status: 403 });
  }

  const lockedChain = await chainLockedResponse(supabase, { billId: id });
  if (lockedChain) return lockedChain;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_po_advance", {
    p_bill_id: id,
    p_amount: parsed.data.amount,
    p_actor: dbUser.id,
  });
  if (error) {
    const code = Object.keys(APPLY_ADVANCE_ERRORS).find((c) => error.message.includes(c));
    if (code) return NextResponse.json({ error: APPLY_ADVANCE_ERRORS[code].message, code }, { status: APPLY_ADVANCE_ERRORS[code].status });
    console.error("[apply-advance] rpc failed:", error.message);
    return NextResponse.json({ error: "Could not apply the advance" }, { status: 500 });
  }

  const result = data as { po_number: string; amount_applied: number; amount_paid: number; payment_status: string; previous: { amount_paid: number; payment_status: string } };
  await logAudit(admin, {
    entityType: "vendor_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      advance_applied: { old: null, new: `${result.amount_applied} from ${result.po_number}` },
      amount_paid: { old: result.previous.amount_paid, new: result.amount_paid },
      payment_status: { old: result.previous.payment_status, new: result.payment_status },
    },
  });

  const { data: bill } = await admin.from("vendor_bills").select("po_id").eq("id", id).maybeSingle();
  const usage = bill?.po_id ? await loadAdvanceUsage(admin, bill.po_id as string) : null;
  return NextResponse.json({ data: { ...result, usage } });
}

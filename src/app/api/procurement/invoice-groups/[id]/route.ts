import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { checkTotalAgainstPos } from "@/lib/procurement/shared-invoice";
import { distinctPoValues } from "@/lib/procurement/shared-invoice-server";

const patchSchema = z.object({
  invoice_total: z.number().positive(),
  reason: z.string().trim().min(10, "Give a reason of at least 10 characters").max(500),
});

/**
 * PATCH /api/procurement/invoice-groups/[id] — correct the total of a shared vendor invoice.
 *
 * Raising it (the first bill held only its own share) is open to admin, manager and accounts;
 * lowering it (a vendor credit note) is admin only. It can never drop below the shares already on
 * the invoice (the database enforces that), and with two or more POs it can't pass their combined value.
 *
 * Deliberately not behind the chain lock: this is not a bill amount, and the correction is often made
 * after the first PO's cycle has closed. Every live bill on the invoice gets an audit entry.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: group } = await admin.from("vendor_invoice_groups").select("id, invoice_total").eq("id", id).single();
  if (!group) return NextResponse.json({ error: "Shared invoice not found" }, { status: 404 });

  const oldTotal = Number(group.invoice_total);
  const newTotal = Math.round(parsed.data.invoice_total * 100) / 100;
  if (Math.abs(newTotal - oldTotal) < 0.01) {
    return NextResponse.json({ error: "That is already the invoice total" }, { status: 422 });
  }
  if (newTotal < oldTotal && dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can lower the invoice total" }, { status: 403 });
  }

  const { data: bills } = await admin
    .from("vendor_bills")
    .select("id, po_id, purchase_orders(total_ordered_amount)")
    .eq("invoice_group_id", id)
    .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
  type Row = { id: string; po_id: string | null; purchase_orders: { total_ordered_amount: number } | { total_ordered_amount: number }[] | null };
  const rows = (bills ?? []) as unknown as Row[];
  const poValues = distinctPoValues(
    rows.map((r) => {
      const po = Array.isArray(r.purchase_orders) ? r.purchase_orders[0] : r.purchase_orders;
      return { po_id: r.po_id, po_value: po ? Number(po.total_ordered_amount) : null };
    }),
  );
  const poGate = checkTotalAgainstPos(newTotal, poValues);
  if (poGate) return NextResponse.json({ error: poGate }, { status: 422 });

  const { error } = await admin.from("vendor_invoice_groups").update({ invoice_total: newTotal }).eq("id", id);
  if (error) {
    if (error.message.includes("SHARED_INVOICE_TOTAL_BELOW_SHARES")) {
      return NextResponse.json({ error: "The invoice total can't be lower than the shares already on its bills." }, { status: 422 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  for (const r of rows) {
    await logAudit(admin, {
      entityType: "vendor_bill",
      entityId: r.id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        shared_invoice_total: { old: oldTotal, new: newTotal },
        shared_invoice_total_reason: { old: null, new: parsed.data.reason },
      },
    });
  }
  return NextResponse.json({ data: { id, invoice_total: newTotal } });
}

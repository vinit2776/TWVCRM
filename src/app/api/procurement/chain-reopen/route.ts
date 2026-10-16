import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { sendPushToProcurementRoles } from "@/lib/push";
import { rollbackReasonSchema } from "@/lib/procurement/admin-rollback";
import { requireRollbackAdmin } from "@/lib/procurement/admin-rollback-server";
import { getChainState } from "@/lib/procurement/chain-lock";

const bodySchema = z.object({
  bill_id: z.string().uuid().optional(),
  po_id: z.string().uuid().optional(),
  pr_id: z.string().uuid().optional(),
  /** The admin must type the chain's number (MR / PO / bill) to confirm. */
  confirm: z.string().trim().min(1, "Type the number to confirm"),
  reason: rollbackReasonSchema,
});

/**
 * POST /api/procurement/chain-reopen
 * Admin only. Reopens a LOCKED procurement cycle so corrections work again.
 * The cycle re-closes by itself, a full grace period after it is complete again.
 */
export async function POST(request: NextRequest) {
  const gate = await requireRollbackAdmin("Only an admin can reopen a closed cycle");
  if ("error" in gate) return gate.error;
  const { supabase, dbUser } = gate;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { bill_id, po_id, pr_id, confirm, reason } = parsed.data;
  if (!bill_id && !po_id && !pr_id) return NextResponse.json({ error: "bill_id, po_id or pr_id is required" }, { status: 400 });

  const found = await getChainState(supabase, { billId: bill_id, poId: po_id, prId: pr_id });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (found.chain.state !== "locked") {
    return NextResponse.json({ error: "This cycle is not locked, so there is nothing to reopen" }, { status: 422 });
  }

  // The number to type is the chain root's own number.
  const { root } = found;
  const table = root.type === "pr" ? "purchase_requests" : root.type === "po" ? "purchase_orders" : "vendor_bills";
  const numberCol = root.type === "pr" ? "pr_number" : root.type === "po" ? "po_number" : "bill_number";
  const { data: rootRow } = await supabase.from(table).select(numberCol).eq("id", root.id).single();
  const rootNumber = (rootRow as unknown as Record<string, string> | null)?.[numberCol];
  if (!rootNumber || confirm.toLowerCase() !== rootNumber.toLowerCase()) {
    return NextResponse.json({ error: `Type ${rootNumber ?? "the number"} exactly to confirm` }, { status: 422 });
  }

  const { error } = await createAdminClient().from("procurement_chain_reopens").insert({
    root_type: root.type,
    root_id: root.id,
    reopened_by: dbUser.id,
    reason,
  });
  if (error) {
    console.error("[chain-reopen] insert failed:", error.message);
    return NextResponse.json({ error: "Could not reopen the cycle" }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: root.type === "pr" ? "purchase_request" : root.type === "po" ? "purchase_order" : "vendor_bill",
    entityId: root.id,
    action: "rollback",
    performedBy: dbUser.id,
    changes: {
      rollback_kind: { old: null, new: "chain_reopened" },
      rollback_reason: { old: null, new: reason },
      cycle: { old: "locked", new: "reopened" },
    },
  });

  // Accounts and the other admins should hear that a closed cycle was reopened.
  sendPushToProcurementRoles({
    title: "Closed procurement cycle reopened",
    body: `${rootNumber} was reopened by an admin: ${reason}`,
    url: root.type === "pr" ? `/procurement/requests/${root.id}` : root.type === "po" ? `/procurement/orders/${root.id}` : `/procurement/bills/${root.id}`,
    tag: `chain-reopen-${root.id}`,
  }).catch((err) => console.error("[push] chain reopen notification failed:", err));

  return NextResponse.json({ data: { root, reopened: true } });
}

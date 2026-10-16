import { chainLockedResponse } from "@/lib/procurement/chain-lock";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { z } from "zod";
import { recalculatePrStatus } from "@/lib/procurement/pr-status";
import { canRollback, rollbackReasonSchema } from "@/lib/procurement/admin-rollback";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { amcStatusFor, poExceedsPrQty, poStatusAfterCancelRestore, poStatusAfterUnmarkReceived } from "@/lib/procurement/po-rollback";

// Admin-only corrections, one step back each. See src/lib/procurement/admin-rollback.ts.
const ROLLBACK_ACTIONS = [
  "unorder", "unmark_received", "restore_cancelled", "restore_partial_cancel", "reopen_advance", "reverse_advance", "reinstate_amc",
] as const;

// restore_partially_cancelled_po raises these as the exception message (00602).
const RESTORE_RPC_ERRORS: Record<string, string> = {
  NOT_PARTIALLY_CANCELLED: "This PO is no longer partially cancelled",
  NO_SNAPSHOT: "The original quantities weren't recorded for this partial cancellation, so it can't be restored. Raise a new PO for the extra quantity.",
  BILLS_PAST_APPROVAL: "A bill on this PO was approved at the reduced amount. Un-approve it first, then restore.",
};

const patchPoSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_ordered") }),
  z.object({
    action: z.literal("mark_received"),
    actual_delivery_date: z.string().nullish(),
  }),
  z.object({ action: z.literal("cancel"), force: z.boolean().optional() }),
  z.object({
    action: z.literal("partial_cancel"),
    confirmed_items: z.array(z.object({
      po_item_id: z.string().uuid(),
      confirmed_qty: z.number().min(0),
    })).min(1),
  }),
  z.object({
    action: z.literal("process_advance"),
    advance_payment_date: z.string().min(1, "Payment date is required"),
    /** UTR / cheque number — required so the recorded payment is traceable. */
    advance_payment_reference: z.string().min(1, "Payment reference (UTR / cheque #) is required"),
    /** Bank rail used to pay the vendor — same enum as bill payments. */
    advance_payment_mode: z.enum(["neft", "rtgs", "imps", "bank_transfer", "cheque", "cash"]),
  }),
  z.object({ action: z.literal("unorder"), reason: rollbackReasonSchema }),
  z.object({ action: z.literal("unmark_received"), reason: rollbackReasonSchema }),
  z.object({ action: z.literal("restore_cancelled"), reason: rollbackReasonSchema }),
  z.object({ action: z.literal("restore_partial_cancel"), reason: rollbackReasonSchema }),
  z.object({ action: z.literal("reopen_advance"), reason: rollbackReasonSchema }),
  z.object({ action: z.literal("reverse_advance"), reason: rollbackReasonSchema }),
  z.object({ action: z.literal("reinstate_amc"), reason: rollbackReasonSchema }),
  z.object({ action: z.literal("approve_advance") }),
  z.object({ action: z.literal("reject_advance") }),
  z.object({
    action: z.literal("update_amc_details"),
    amc_start_date: z.string().nullable().optional(),
    amc_end_date: z.string().nullable().optional(),
    amc_visits_covered: z.number().int().positive().nullable().optional(),
    amc_contact_name: z.string().nullable().optional(),
    amc_helpline_number: z.string().nullable().optional(),
    amc_contact_email: z.string().email().nullable().optional().or(z.literal("").transform(() => null)),
  }),
  z.object({
    action: z.literal("terminate_amc"),
    termination_reason: z.string().min(10, "Reason must be at least 10 characters"),
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
    .from("purchase_orders")
    .select(
      `*, purchase_order_items(*, linked_asset:facility_assets(id, name, asset_code), procurement_items(id, name, description)), procurement_vendors(id, name, contact_name, contact_phone, contact_email), locations(id, name), companies(id, name, brand_name, gstin, address, city, state, pincode, phone, email), orderer:users!purchase_orders_ordered_by_fkey(id, full_name, email), terminator:users!amc_terminated_by(id, full_name), purchase_requests(id, pr_number, department, expenditure_type, approval_code, approved_at, approver:users!purchase_requests_approved_by_fkey(id, full_name, email)), po_delivery_receipts(*, receiver:users!po_delivery_receipts_received_by_fkey(id, full_name, email), po_delivery_receipt_items(id, po_item_id, qty_received)), po_service_reports(*, recorder:users!po_service_reports_recorded_by_fkey(id, full_name)), vendor_bills(id, bill_number, invoice_date, invoice_file_url, total_amount, payment_status, approval_status, service_report_id, created_at, creator:users!vendor_bills_created_by_fkey(id, full_name))`
    )
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  // Fetch audit trail for this PO (for activity timeline)
  const { data: auditEvents } = await supabase
    .from("audit_trail")
    .select("id, action, changes, performed_by, created_at, performer:users!audit_trail_performed_by_fkey(id, full_name)")
    .eq("entity_type", "purchase_order")
    .eq("entity_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ data, audit_events: auditEvents ?? [] });
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

  const { data: po, error: fetchError } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  // A closed cycle is read-only until an admin reopens it (see chain-lock.ts).
  const lockedChain = await chainLockedResponse(supabase, { poId: id });
  if (lockedChain) return lockedChain;

  const body = await request.json();
  const parsed = patchPoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { action } = parsed.data;
  let updatePayload: Record<string, unknown> = {};
  const extraAuditChanges: Record<string, { old: unknown; new: unknown }> = {};
  const isRollback = (ROLLBACK_ACTIONS as readonly string[]).includes(action);
  if (isRollback && !canRollback(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin can roll back a purchase order step" }, { status: 403 });
  }

  switch (action) {
    case "mark_ordered": {
      if (po.status !== "pending") {
        return NextResponse.json({ error: "Only pending POs can be marked as ordered" }, { status: 422 });
      }
      if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      updatePayload = { status: "ordered" };

      // ── Auto-learn vendor prices from this PO (best-effort, non-blocking) ──
      // Fetch catalog line items with a unit price
      try {
        const { data: poItems } = await supabase
          .from("purchase_order_items")
          .select("item_id, unit_price, gst_rate")
          .eq("po_id", id)
          .not("item_id", "is", null)
          .not("unit_price", "is", null)
          .gt("unit_price", 0);

        for (const li of poItems ?? []) {
          await supabase.from("vendor_item_prices").upsert(
            {
              vendor_id:      po.vendor_id,
              item_id:        li.item_id,
              price:          li.unit_price,
              gst_rate:       li.gst_rate ?? 0,
              last_po_id:     id,
              last_po_number: po.po_number,
              updated_by:     dbUser.id,
              updated_at:     new Date().toISOString(),
            },
            { onConflict: "vendor_id,item_id" }
          );
        }
      } catch {
        // Price sync failure must never fail the status transition
      }

      break;
    }

    case "mark_received": {
      if (!["ordered", "partially_received"].includes(po.status)) {
        return NextResponse.json({ error: "Only ordered or partially received POs can be marked as received" }, { status: 422 });
      }
      if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      const today = new Date().toISOString().split("T")[0];
      updatePayload = {
        status: "received",
        actual_delivery_date: parsed.data.actual_delivery_date ?? today,
      };
      break;
    }

    case "cancel": {
      if (!["pending", "ordered", "partially_received", "received"].includes(po.status)) {
        return NextResponse.json({ error: "Only pre-invoice POs can be cancelled" }, { status: 422 });
      }
      if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }

      // Block cancellation if vendor bills exist — must handle bills first.
      // A withdrawn bill is out of play (admin pulled it back), so it doesn't block.
      const { count: billCount } = await supabase
        .from("vendor_bills")
        .select("id", { count: "exact", head: true })
        .eq("po_id", id)
        .neq("approval_status", "withdrawn");
      if (billCount && billCount > 0) {
        return NextResponse.json({
          error: "This PO has vendor bills. An admin must withdraw them before the PO can be cancelled.",
        }, { status: 422 });
      }

      // If PO has received goods, require force flag
      if (["partially_received", "received"].includes(po.status)) {
        const { count: deliveryCount } = await supabase
          .from("po_delivery_receipts")
          .select("id", { count: "exact", head: true })
          .eq("po_id", id);
        if (deliveryCount && deliveryCount > 0 && !parsed.data.force) {
          return NextResponse.json({
            error: "This PO has received goods. Use force cancel or reject deliveries first.",
            has_deliveries: true,
          }, { status: 422 });
        }
      }

      // Remembered so an admin can restore the PO to exactly where it was.
      updatePayload = { status: "cancelled", status_before_cancel: po.status };
      break;
    }

    case "partial_cancel": {
      if (po.status !== "invoice_received") {
        return NextResponse.json({ error: "Only invoice_received POs can be partially cancelled" }, { status: 422 });
      }
      if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }

      const { confirmed_items } = parsed.data;

      const { data: poItems } = await supabase
        .from("purchase_order_items")
        .select("id, quantity_ordered, unit_price")
        .eq("po_id", id);

      const poItemMap = Object.fromEntries((poItems ?? []).map((i) => [i.id, i]));

      for (const ci of confirmed_items) {
        const poItem = poItemMap[ci.po_item_id];
        if (!poItem) {
          return NextResponse.json({ error: `Item ${ci.po_item_id} not found` }, { status: 422 });
        }
        if (ci.confirmed_qty > Number(poItem.quantity_ordered)) {
          return NextResponse.json({ error: "Confirmed qty exceeds ordered qty" }, { status: 422 });
        }
      }

      // Reduce quantity_ordered to confirmed_qty on each item
      for (const ci of confirmed_items) {
        await supabase.from("purchase_order_items")
          .update({ quantity_ordered: ci.confirmed_qty })
          .eq("id", ci.po_item_id)
          .eq("po_id", id);
      }

      // Recompute PO total
      const { data: updatedItems } = await supabase
        .from("purchase_order_items")
        .select("quantity_ordered, unit_price")
        .eq("po_id", id);
      const newTotal = (updatedItems ?? []).reduce(
        (s, i) => s + Number(i.quantity_ordered) * Number(i.unit_price ?? 0), 0
      );

      // ── Sync existing vendor bills down to the reduced PO total ───────────
      const { data: existingBills } = await supabase
        .from("vendor_bills")
        .select("id, total_amount, amount_paid, payment_status")
        .eq("po_id", id)
        .neq("approval_status", "withdrawn");

      // Snapshot what this action is about to change so an admin can restore it.
      const partialCancelSnapshot = {
        status_before: po.status,
        total_ordered_amount: po.total_ordered_amount ?? null,
        items: (poItems ?? []).map((i) => ({ id: i.id, quantity_ordered: Number(i.quantity_ordered) })),
        bills: (existingBills ?? []).map((b) => ({ id: b.id, total_amount: Number(b.total_amount), payment_status: b.payment_status })),
      };

      for (const bill of existingBills ?? []) {
        const amountPaid = Number(bill.amount_paid);
        // Guard: cannot reduce below an already-paid amount
        if (amountPaid > newTotal) {
          return NextResponse.json({
            error: `Cannot partially cancel: bill already has ₹${amountPaid.toLocaleString("en-IN")} paid, which exceeds the new PO total of ₹${newTotal.toLocaleString("en-IN")}`,
          }, { status: 422 });
        }
        if (Number(bill.total_amount) > newTotal) {
          const newPaymentStatus =
            amountPaid >= newTotal ? "paid" :
            amountPaid > 0 ? "partially_paid" :
            "unpaid";
          await supabase
            .from("vendor_bills")
            .update({ total_amount: newTotal, payment_status: newPaymentStatus })
            .eq("id", bill.id);
        }
      }

      updatePayload = { status: "partially_cancelled", total_ordered_amount: newTotal, partial_cancel_snapshot: partialCancelSnapshot };
      break;
    }

    case "unorder": {
      if (po.status !== "ordered") {
        return NextResponse.json({ error: "Only an ordered PO can be moved back to pending" }, { status: 422 });
      }
      const [{ count: receipts }, { count: bills }, { count: reports }] = await Promise.all([
        supabase.from("po_delivery_receipts").select("id", { count: "exact", head: true }).eq("po_id", id),
        supabase.from("vendor_bills").select("id", { count: "exact", head: true }).eq("po_id", id).neq("approval_status", "withdrawn"),
        supabase.from("po_service_reports").select("id", { count: "exact", head: true }).eq("po_id", id),
      ]);
      if ((receipts ?? 0) > 0) {
        return NextResponse.json({ error: "Goods have been received against this PO. Reject the deliveries first." }, { status: 422 });
      }
      if ((bills ?? 0) > 0) {
        return NextResponse.json({ error: "This PO has vendor bills. Withdraw them first." }, { status: 422 });
      }
      if ((reports ?? 0) > 0 || Number(po.amc_visits_used ?? 0) > 0) {
        return NextResponse.json({ error: "Service work has been logged against this PO, so it can't go back to pending." }, { status: 422 });
      }
      if (po.advance_status === "processed") {
        return NextResponse.json({ error: "The advance has been paid. Reverse it first." }, { status: 422 });
      }
      // vendor_item_prices learned at mark_ordered is deliberately left alone:
      // the previous price it overwrote isn't recorded, so it can't be put back.
      updatePayload = { status: "pending" };
      break;
    }

    case "unmark_received": {
      if (po.status !== "received") {
        return NextResponse.json({ error: "Only a received PO can be un-marked" }, { status: 422 });
      }
      const { data: items } = await supabase
        .from("purchase_order_items").select("quantity_ordered, quantity_received").eq("po_id", id);
      const next = poStatusAfterUnmarkReceived(items ?? []);
      if (!next) {
        return NextResponse.json(
          { error: "Delivery receipts cover the whole order, so Received is correct. Reject the wrong delivery instead." },
          { status: 422 }
        );
      }
      updatePayload = { status: next, actual_delivery_date: null };
      break;
    }

    case "restore_cancelled": {
      if (po.status !== "cancelled") {
        return NextResponse.json({ error: "Only a cancelled PO can be restored" }, { status: 422 });
      }
      if (po.pr_id) {
        const { data: pr } = await supabase.from("purchase_requests").select("status").eq("id", po.pr_id).single();
        if (!pr || !["approved", "partially_ordered", "po_created"].includes(pr.status)) {
          return NextResponse.json({ error: "The material request is no longer open for ordering, so this PO can't be restored" }, { status: 422 });
        }
      }
      const overflow = await poExceedsPrQty(supabase, id);
      if (overflow) return NextResponse.json({ error: overflow }, { status: 422 });
      const { data: items } = await supabase
        .from("purchase_order_items").select("quantity_ordered, quantity_received").eq("po_id", id);
      updatePayload = {
        status: poStatusAfterCancelRestore(po.status_before_cancel ?? null, items ?? []),
        status_before_cancel: null,
      };
      break;
    }

    case "restore_partial_cancel": {
      if (po.status !== "partially_cancelled") {
        return NextResponse.json({ error: "Only a partially cancelled PO can be restored" }, { status: 422 });
      }
      const snap = po.partial_cancel_snapshot as { items?: Array<{ id: string; quantity_ordered: number }> } | null;
      if (!snap) return NextResponse.json({ error: RESTORE_RPC_ERRORS.NO_SNAPSHOT }, { status: 422 });
      const qtyByItem = Object.fromEntries((snap.items ?? []).map((i) => [i.id, Number(i.quantity_ordered)]));
      const overflow = await poExceedsPrQty(supabase, id, qtyByItem);
      if (overflow) return NextResponse.json({ error: overflow }, { status: 422 });

      const { data: result, error: rpcError } = await createAdminClient().rpc("restore_partially_cancelled_po", {
        p_po_id: id,
        p_actor: dbUser.id,
      });
      if (rpcError) {
        const known = Object.entries(RESTORE_RPC_ERRORS).find(([code]) => rpcError.message.includes(code));
        if (known) return NextResponse.json({ error: known[1] }, { status: 422 });
        console.error(`[orders/${id}] restore partial cancel failed:`, rpcError.message);
        return NextResponse.json({ error: "Could not restore the partial cancellation" }, { status: 500 });
      }
      if (po.pr_id) await recalculatePrStatus(supabase, po.pr_id);
      await logAudit(supabase, {
        entityType: "purchase_order",
        entityId: id,
        action: "rollback",
        performedBy: dbUser.id,
        changes: {
          rollback_kind: { old: null, new: "partial_cancel_restored" },
          rollback_reason: { old: null, new: parsed.data.reason },
          status: { old: po.status, new: result?.status },
          total_ordered_amount: { old: po.total_ordered_amount, new: result?.total_ordered_amount },
        },
      });
      return NextResponse.json({ data: result });
    }

    case "reopen_advance": {
      if (po.advance_status === "processed") {
        return NextResponse.json({ error: "The advance has already been paid. Reverse the payment first." }, { status: 422 });
      }
      if (!["approved", "rejected"].includes(po.advance_approval_status ?? "")) {
        return NextResponse.json({ error: "There is no approval decision to re-open" }, { status: 422 });
      }
      updatePayload = { advance_approval_status: "pending_review" };
      break;
    }

    case "reverse_advance": {
      if (po.advance_status !== "processed") {
        return NextResponse.json({ error: "This advance has not been paid" }, { status: 422 });
      }
      // New bills on this PO were pre-credited with the advance (amount_paid),
      // so undoing the advance would leave them showing money that was never paid.
      const { count: liveBills } = await supabase
        .from("vendor_bills")
        .select("id", { count: "exact", head: true })
        .eq("po_id", id)
        .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
      if ((liveBills ?? 0) > 0) {
        return NextResponse.json(
          { error: "Bills on this PO were credited with the advance. Withdraw or reject them first." },
          { status: 422 }
        );
      }
      updatePayload = {
        advance_status: "pending",
        advance_processed_by: null,
        advance_processed_at: null,
        advance_payment_date: null,
        advance_payment_mode: null,
        advance_payment_reference: null,
      };
      break;
    }

    case "reinstate_amc": {
      if (po.po_type !== "service" || !po.amc_terminated_at) {
        return NextResponse.json({ error: "This contract has not been terminated" }, { status: 422 });
      }
      if (["cancelled", "partially_cancelled"].includes(po.status)) {
        return NextResponse.json({ error: "The purchase order is cancelled. Restore it first." }, { status: 422 });
      }
      updatePayload = {
        amc_terminated_at: null,
        amc_terminated_by: null,
        amc_termination_reason: null,
        amc_status: amcStatusFor({
          start: po.amc_start_date ?? null,
          end: po.amc_end_date ?? null,
          visitsCovered: po.amc_visits_covered != null ? Number(po.amc_visits_covered) : null,
          visitsUsed: Number(po.amc_visits_used ?? 0),
          today: new Date(),
        }),
      };
      break;
    }

    case "approve_advance": {
      if (dbUser.role !== "admin") {
        return NextResponse.json({ error: "Only admin can approve advance payments" }, { status: 403 });
      }
      if (po.advance_approval_status !== "pending_review") {
        return NextResponse.json({ error: "Advance is not pending review" }, { status: 422 });
      }
      updatePayload = { advance_approval_status: "approved" };
      break;
    }

    case "reject_advance": {
      if (dbUser.role !== "admin") {
        return NextResponse.json({ error: "Only admin can reject advance payments" }, { status: 403 });
      }
      if (po.advance_approval_status !== "pending_review") {
        return NextResponse.json({ error: "Advance is not pending review" }, { status: 422 });
      }
      updatePayload = { advance_approval_status: "rejected" };
      break;
    }

    case "process_advance": {
      if (po.advance_status !== "pending") {
        return NextResponse.json({ error: "Only POs with a pending advance can be processed" }, { status: 422 });
      }
      if (po.advance_approval_status !== "approved") {
        return NextResponse.json({ error: "Advance must be approved by admin before it can be processed" }, { status: 422 });
      }
      // PO advances are now released by Finance (same roles that record bill
      // payments). Bank modes for accounts/admin; cash allowed for office_admin
      // (petty cash) and admin only.
      const mode = parsed.data.advance_payment_mode;
      const isBankMode = ["neft", "rtgs", "imps", "bank_transfer", "cheque"].includes(mode);
      if (!["admin", "accounts", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only Accounts, Office Admin or Admin can release PO advances" }, { status: 403 });
      }
      if (dbUser.role === "accounts" && !isBankMode) {
        return NextResponse.json({ error: "Accounts team can only record bank payments (NEFT, RTGS, IMPS, Bank Transfer, Cheque)" }, { status: 403 });
      }
      if (dbUser.role === "office_admin" && mode !== "cash") {
        return NextResponse.json({ error: "Petty cash payments only — bank payments must be processed by the Accounts team" }, { status: 403 });
      }
      updatePayload = {
        advance_status: "processed",
        advance_processed_by: dbUser.id,
        advance_processed_at: new Date().toISOString(),
        advance_payment_date: parsed.data.advance_payment_date,
        advance_payment_mode: mode,
        advance_payment_reference: parsed.data.advance_payment_reference,
      };
      break;
    }

    case "update_amc_details": {
      if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      const { amc_start_date, amc_end_date, amc_visits_covered, amc_contact_name, amc_helpline_number, amc_contact_email } = parsed.data;

      // Compute amc_status from new values
      const today = new Date();
      const start = amc_start_date ? new Date(amc_start_date) : null;
      const end = amc_end_date ? new Date(amc_end_date) : null;
      const visitsUsed = Number(po.amc_visits_used ?? 0);
      let newAmcStatus = "inactive";
      if (start && today >= start) {
        if (end && today > end) {
          newAmcStatus = "expired";
        } else if (amc_visits_covered !== undefined && amc_visits_covered !== null && visitsUsed >= amc_visits_covered) {
          newAmcStatus = "exhausted";
        } else if (end) {
          const daysLeft = Math.floor((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          newAmcStatus = daysLeft <= 60 ? "expiring" : "active";
        } else {
          newAmcStatus = "active";
        }
      }

      updatePayload = {
        amc_start_date: amc_start_date ?? null,
        amc_end_date: amc_end_date ?? null,
        amc_visits_covered: amc_visits_covered ?? null,
        amc_contact_name: amc_contact_name ?? null,
        amc_helpline_number: amc_helpline_number ?? null,
        amc_contact_email: amc_contact_email ?? null,
        amc_status: newAmcStatus,
      };
      break;
    }

    case "terminate_amc": {
      // Admin/manager only — terminating an AMC mid-contract is a destructive,
      // irreversible action. Once terminated, no new events can be logged and
      // the only way back is to create a new PO.
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json(
          { error: "Only admin and manager can terminate an AMC" },
          { status: 403 }
        );
      }
      if (po.po_type !== "service") {
        return NextResponse.json(
          { error: "Termination is only available on service / AMC POs" },
          { status: 422 }
        );
      }
      if (po.amc_terminated_at) {
        return NextResponse.json(
          { error: "This AMC has already been terminated" },
          { status: 422 }
        );
      }
      if (!["active", "expiring"].includes(po.amc_status ?? "")) {
        return NextResponse.json(
          { error: `Can only terminate an active or expiring AMC (current state: ${po.amc_status ?? "unknown"})` },
          { status: 422 }
        );
      }
      updatePayload = {
        amc_terminated_at: new Date().toISOString(),
        amc_terminated_by: dbUser.id,
        amc_termination_reason: parsed.data.termination_reason.trim(),
        amc_status: "terminated",
      };
      break;
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("purchase_orders")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  // Recalculate PR status after any cancellation (or restore) so remaining qty tracks reality
  if (["cancel", "partial_cancel", "restore_cancelled"].includes(action) && po.pr_id) {
    await recalculatePrStatus(supabase, po.pr_id);
  }

  if (isRollback && "reason" in parsed.data) {
    extraAuditChanges.rollback_kind = { old: null, new: ({
      unorder: "order_reversed",
      unmark_received: "received_reversed",
      restore_cancelled: "cancel_restored",
      reopen_advance: "advance_reopened",
      reverse_advance: "advance_reversed",
      reinstate_amc: "amc_reinstated",
    } as Record<string, string>)[action] ?? action };
    extraAuditChanges.rollback_reason = { old: null, new: parsed.data.reason };
  }

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: id,
    action: isRollback ? "rollback" : "update",
    performedBy: dbUser.id,
    changes: {
      ...diffChanges(po as Record<string, unknown>, { ...po, ...updatePayload } as Record<string, unknown>),
      ...extraAuditChanges,
    },
  });

  return NextResponse.json({ data: updated });
}

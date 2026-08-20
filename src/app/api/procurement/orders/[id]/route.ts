import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { z } from "zod";
import { recalculatePrStatus } from "@/lib/procurement/pr-status";
import { getBillVoidBlocker, voidBill } from "@/lib/procurement/void-bill";
import { reverseDeliveryReceipt } from "@/lib/procurement/reverse-delivery";

const patchPoSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_ordered") }),
  z.object({
    action: z.literal("mark_received"),
    actual_delivery_date: z.string().nullish(),
  }),
  z.object({
    action: z.literal("cancel"),
    force: z.boolean().optional(),
    /**
     * Optional today so existing UI callers keep working unchanged. When
     * present it's recorded on the audit trail and reused as the void reason
     * for any child vendor bills; when absent a derived reason mentioning the
     * PO number is used instead.
     */
    reason: z.string().min(10, "A reason of at least 10 characters is required").optional(),
  }),
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
      `*, purchase_order_items(*, procurement_items(id, name, description)), procurement_vendors(id, name, contact_name, contact_phone, contact_email), locations(id, name), orderer:users!purchase_orders_ordered_by_fkey(id, full_name, email), terminator:users!amc_terminated_by(id, full_name), purchase_requests(id, pr_number, department, expenditure_type, approval_code, approved_at, approver:users!purchase_requests_approved_by_fkey(id, full_name, email)), po_delivery_receipts(*, receiver:users!po_delivery_receipts_received_by_fkey(id, full_name, email), po_delivery_receipt_items(id, po_item_id, qty_received)), po_service_reports(*, recorder:users!po_service_reports_recorded_by_fkey(id, full_name)), vendor_bills(id, bill_number, invoice_date, invoice_file_url, total_amount, payment_status, approval_status, service_report_id, created_at, creator:users!vendor_bills_created_by_fkey(id, full_name))`
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

  const body = await request.json();
  const parsed = patchPoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { action } = parsed.data;
  let updatePayload: Record<string, unknown> = {};
  // Extra audit-trail entries that don't come from the purchase_orders row diff
  // (e.g. the cancel reason isn't a column on purchase_orders).
  const extraAuditChanges: Record<string, { old: unknown; new: unknown }> = {};

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
      // invoice_received / invoice_approved are included here (widened from the
      // original pre-invoice-only list) because the blanket "has vendor bills"
      // block below has been replaced with a per-bill voidability check —
      // cancellation is allowed as long as no money has moved on any bill, no
      // matter how far along the PO's invoice status is.
      if (!["pending", "ordered", "partially_received", "received", "invoice_received", "invoice_approved"].includes(po.status)) {
        return NextResponse.json({ error: "This PO cannot be cancelled from its current status" }, { status: 422 });
      }
      if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }

      // Fail fast on the cheapest, most-likely-to-fail check before any write.
      // NOTE (Phase 2 follow-up): this handler is not transactional — writes
      // below happen sequentially, same as the existing partial_cancel case.
      // If a later write fails, earlier ones (e.g. a voided bill) are not
      // rolled back. Wrapping this in an RPC is deferred to Phase 2.
      const { data: poBills } = await supabase
        .from("vendor_bills")
        .select("id, bill_number, approval_status")
        .eq("po_id", id);
      const bills = poBills ?? [];

      const blockedBills: { bill_number: string; reason: string }[] = [];
      for (const b of bills) {
        const blocker = await getBillVoidBlocker(supabase, b.id);
        if (blocker) {
          blockedBills.push({ bill_number: b.bill_number, reason: blocker });
        }
      }
      if (blockedBills.length > 0) {
        return NextResponse.json({
          error: `This PO cannot be cancelled — ${blockedBills.length} bill${blockedBills.length > 1 ? "s" : ""} blocked: ${blockedBills.map((b) => `${b.bill_number} (${b.reason})`).join("; ")}`,
          blocked_bills: blockedBills,
        }, { status: 422 });
      }

      // Voiding an already-approved bill reverses an admin-only decision, so
      // escalate the role gate for this PO's cancel action specifically when
      // any of its bills have been approved. A PO whose bills are all still
      // pending (or has no bills) stays cancellable by manager/office_admin.
      const hasApprovedBill = bills.some((b) => b.approval_status === "approved");
      if (hasApprovedBill && dbUser.role !== "admin") {
        return NextResponse.json({
          error: "This PO has an approved vendor bill — only admin can cancel it (voiding an approved bill requires admin).",
        }, { status: 403 });
      }

      const cancelReason = parsed.data.reason?.trim() || `PO ${po.po_number} cancelled`;

      // If PO has received goods, require force flag. force:true no longer
      // ignores the received stock — it reverses it (see below), same as
      // rejecting each delivery would.
      if (["partially_received", "received"].includes(po.status)) {
        const { data: receipts } = await supabase
          .from("po_delivery_receipts")
          .select("id, dc_number, dc_date, po_delivery_receipt_items(po_item_id, qty_received)")
          .eq("po_id", id);
        const deliveryReceipts = receipts ?? [];

        if (deliveryReceipts.length > 0 && !parsed.data.force) {
          return NextResponse.json({
            error: "This PO has received goods. Use force cancel to reverse the received stock, or reject deliveries first.",
            has_deliveries: true,
          }, { status: 422 });
        }

        if (deliveryReceipts.length > 0 && parsed.data.force) {
          // Snapshot what was physically received BEFORE reversing. The
          // po_delivery_receipt(_items) rows themselves now SURVIVE
          // cancellation (disposition: "retain" — stamped reversed_at /
          // reversed_by / reversal_reason instead of deleted), but this
          // snapshot is kept anyway: it records the exact state at the
          // moment of cancellation directly on the audit_trail entry,
          // independent of whatever the receipt rows look like later.
          extraAuditChanges.reversed_delivery_receipts = {
            old: null,
            new: deliveryReceipts.map((r) => ({
              receipt_id: r.id,
              dc_number: r.dc_number,
              dc_date: r.dc_date,
              items: (r.po_delivery_receipt_items ?? []).map((i) => ({
                po_item_id: i.po_item_id,
                qty_received: i.qty_received,
              })),
            })),
          };

          // NOTE (Phase 2 follow-up, same as the bill-voiding loop above):
          // this handler is not transactional — each receipt is reversed
          // sequentially. If one fails partway through, earlier reversals
          // are not rolled back. Wrapping this in an RPC is deferred to
          // Phase 2.
          for (const receipt of deliveryReceipts) {
            const reverseResult = await reverseDeliveryReceipt(supabase, {
              receiptId: receipt.id,
              poId: id,
              disposition: "retain",
              reversedBy: dbUser.id,
              reason: cancelReason,
            });
            if (!reverseResult.ok) {
              return NextResponse.json({
                error: `Failed to reverse delivery receipt ${receipt.dc_number ?? receipt.id}: ${reverseResult.error}`,
              }, { status: 500 });
            }
          }
        }
      }

      extraAuditChanges.cancel_reason = { old: null, new: cancelReason };

      // All bills passed the blocker check above — void each one now, before
      // flipping the PO's own status.
      for (const b of bills) {
        const voidResult = await voidBill(supabase, {
          billId: b.id,
          actorId: dbUser.id,
          reason: cancelReason,
        });
        if (!voidResult.ok) {
          // Should be rare given the pre-check above, but surfaces cleanly if
          // state changed between the check and the write (no transaction —
          // see Phase 2 note above).
          return NextResponse.json({ error: `Failed to void bill ${b.bill_number}: ${voidResult.error}` }, { status: 500 });
        }
      }

      updatePayload = { status: "cancelled" };
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
        .eq("po_id", id);

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

      updatePayload = { status: "partially_cancelled", total_ordered_amount: newTotal };
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

  // Recalculate PR status after any cancellation so remaining qty is freed
  if (["cancel", "partial_cancel"].includes(action) && po.pr_id) {
    await recalculatePrStatus(supabase, po.pr_id);
  }

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      ...diffChanges(po as Record<string, unknown>, { ...po, ...updatePayload } as Record<string, unknown>),
      ...extraAuditChanges,
    },
  });

  return NextResponse.json({ data: updated });
}

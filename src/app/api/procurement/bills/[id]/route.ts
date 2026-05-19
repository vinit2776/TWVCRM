import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { sendPushToProcurementRoles } from "@/lib/push";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";
import { computeBatchDate, toISODateString } from "@/lib/payment-batch";
import { z } from "zod";

const BANK_MODES = ["bank_transfer", "neft", "rtgs", "imps", "cheque"] as const;

const HOLD_REASON_LABELS: Record<string, string> = {
  wrong_scan: "Wrong or unclear invoice scan",
  wrong_bank_details: "Bank details incorrect",
  bank_rejected: "Payment rejected by bank",
  amount_mismatch: "Amount doesn't match approved bill",
  duplicate_suspected: "Suspected duplicate payment",
  pending_docs: "Supporting documents missing",
  other: "Other reason",
};
const ALL_PAYMENT_MODES = [...BANK_MODES, "cash"] as const;

const tdsSchema = z.object({
  section_code: z.string().min(1),
  vendor_type: z.enum(["individual", "huf", "company"]).default("company"),
  base_amount: z.number().positive(),
  tds_rate: z.number().positive(),
  tds_amount: z.number().positive(),
  pan_available: z.boolean().default(true),
});

const patchBillSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("record_payment"),
    amount: z.number().positive("Payment amount must be greater than 0"),
    payment_mode: z.enum(ALL_PAYMENT_MODES),
    payment_reference: z.string().nullish(),
    payment_date: z.string().nullish(),
    notes: z.string().nullish(),
    tds: tdsSchema.nullish(),
  }),
  z.object({
    action: z.literal("approve"),
    approved_amount: z.number().positive().nullish(),
    approved_amount_note: z.string().nullish(),
    batch_type: z.enum(["immediate", "15th", "25th"]),
    gst_amount: z.number().min(0, "GST amount must be 0 or greater"),
    gst_zero_confirmed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("override_batch"),
    batch_type: z.enum(["immediate", "15th", "25th"]),
    reason: z.string().nullish(),
  }),
  z.object({
    action: z.literal("approve_balance"),
  }),
  z.object({
    action: z.literal("reject"),
    rejection_reason: z.string().min(1, "Rejection reason is required"),
    rejection_outcome: z.enum(["return", "replacement"]).optional(),
  }),
  z.object({
    action: z.literal("hold_payment"),
    hold_reason: z.enum([
      "wrong_scan", "wrong_bank_details", "bank_rejected",
      "amount_mismatch", "duplicate_suspected", "pending_docs", "other",
    ]),
    hold_notes: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal("release_hold"),
    resolution_notes: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal("update_gst"),
    gst_amount: z.number().min(0, "GST amount must be 0 or greater"),
    /** Required when gst_amount === 0 — user must explicitly confirm no-GST */
    gst_zero_confirmed: z.boolean().optional(),
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
      `*, procurement_vendors(id, name, contact_name, contact_phone),
       purchase_orders(id, po_number, status, po_type, advance_status, advance_amount, advance_payment_mode, advance_payment_reference, advance_payment_date),
       approver:users!vendor_bills_approved_by_fkey(id, full_name),
       vendor_bill_payments(id, amount, payment_mode, payment_reference, payment_date, notes, created_at, recorder:users!vendor_bill_payments_recorded_by_fkey(id, full_name)),
       vendor_bill_batch_changes(id, changed_at, old_batch_type, new_batch_type, old_batch_date, new_batch_date, reason, changer:users!vendor_bill_batch_changes_changed_by_fkey(id, full_name))`
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

  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const canAct = ["admin", "manager", "office_admin", "accounts"].includes(dbUser.role);
  if (!canAct) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  // Approval actions require admin or manager
  const canApproveOrReject = ["admin", "manager"].includes(dbUser.role);

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
      // Role-based payment mode gate
      // - accounts: bank modes only (primary payment processor)
      // - admin: all modes (bank + cash, standby)
      // - office_admin: cash only (petty cash exception, procurement context)
      // - everyone else: no payment access
      const mode = parsed.data.payment_mode;
      const isBankMode = BANK_MODES.includes(mode as typeof BANK_MODES[number]);
      if (dbUser.role === "accounts" && !isBankMode) {
        return NextResponse.json({ error: "Accounts team can only record bank payments (NEFT, RTGS, IMPS, Bank Transfer, Cheque)" }, { status: 403 });
      }
      if (dbUser.role === "office_admin" && mode !== "cash") {
        return NextResponse.json({ error: "Petty cash payments only — bank payments must be processed by the Accounts team" }, { status: 403 });
      }
      if (dbUser.role === "manager") {
        return NextResponse.json({ error: "Payment recording is handled by the Accounts team (bank) or Office Admin (petty cash)" }, { status: 403 });
      }
      if (!["admin", "office_admin", "accounts"].includes(dbUser.role)) {
        return NextResponse.json({ error: "You do not have permission to record payments" }, { status: 403 });
      }

      // Gate: must be approved before payment
      if (bill.approval_status !== "approved") {
        return NextResponse.json(
          { error: "Invoice must be approved before recording a payment" },
          { status: 422 }
        );
      }

      if (bill.payment_status === "paid") {
        return NextResponse.json({ error: "This bill is already fully paid" }, { status: 422 });
      }

      // total_amount = base (pre-GST). gst_amount is additive on top.
      // Approved ceiling = approved base + GST. This will exceed total_amount — that is correct.
      const gstAmount = Number(bill.gst_amount ?? 0);
      const totalAmount = Number(bill.total_amount ?? 0);
      const approvedBase = Number(bill.approved_amount ?? totalAmount);
      const approvedCeiling = approvedBase + gstAmount;
      const alreadyPaid = Number(bill.amount_paid ?? 0);
      const remainingApproved = approvedCeiling - alreadyPaid;

      if (parsed.data.amount > remainingApproved + 0.01) {
        const ceilingLabel = gstAmount > 0
          ? `₹${approvedBase.toFixed(2)} (base) + ₹${gstAmount.toFixed(2)} (GST) = ₹${approvedCeiling.toFixed(2)}`
          : `₹${approvedCeiling.toFixed(2)}`;
        return NextResponse.json(
          { error: `Payment of ₹${parsed.data.amount} exceeds the approved balance of ₹${remainingApproved.toFixed(2)}. Approved ceiling: ${ceilingLabel}.` },
          { status: 422 }
        );
      }

      const newAmountPaid = alreadyPaid + parsed.data.amount;
      // Mark as paid when approved ceiling (base + GST) is fully settled
      const paymentStatus =
        newAmountPaid >= approvedCeiling - 0.01
          ? "paid"
          : newAmountPaid > 0
          ? "partially_paid"
          : "unpaid";

      const today = new Date().toISOString().split("T")[0];
      const paymentDate = parsed.data.payment_date ?? today;

      // Insert payment history record — capture ID for TDS linkage
      const { data: paymentRow } = await supabase
        .from("vendor_bill_payments")
        .insert({
          bill_id: id,
          amount: parsed.data.amount,
          payment_mode: parsed.data.payment_mode,
          payment_reference: parsed.data.payment_reference ?? null,
          payment_date: paymentDate,
          notes: parsed.data.notes ?? null,
          recorded_by: dbUser.id,
        })
        .select("id")
        .single();

      // Atomically insert TDS deduction if provided
      if (parsed.data.tds && paymentRow?.id) {
        const tds = parsed.data.tds;
        const pd = new Date(paymentDate);
        await supabase.from("vendor_bill_tds").insert({
          bill_id: id,
          payment_id: paymentRow.id,
          section_code: tds.section_code,
          vendor_type: tds.vendor_type,
          base_amount: tds.base_amount,
          tds_rate: tds.tds_rate,
          tds_amount: tds.tds_amount,
          pan_available: tds.pan_available,
          period_month: pd.getMonth() + 1,
          period_year: pd.getFullYear(),
          created_by: dbUser.id,
        });
      }

      updatePayload = {
        amount_paid: newAmountPaid,
        payment_status: paymentStatus,
        payment_mode: parsed.data.payment_mode,
        payment_reference: parsed.data.payment_reference ?? null,
        payment_date: paymentDate,
      };
      break;
    }

    case "approve": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin or manager can approve bills" }, { status: 403 });
      }
      if (bill.approval_status !== "pending") {
        return NextResponse.json(
          { error: "Only pending bills can be approved" },
          { status: 422 }
        );
      }

      // Validate partial amount if provided
      const approvedAmt = parsed.data.approved_amount ?? null;
      if (approvedAmt !== null) {
        if (approvedAmt > Number(bill.total_amount)) {
          return NextResponse.json(
            { error: `Approved amount (₹${approvedAmt}) cannot exceed invoice total (₹${bill.total_amount})` },
            { status: 422 }
          );
        }
        if (approvedAmt <= 0) {
          return NextResponse.json({ error: "Approved amount must be greater than zero" }, { status: 422 });
        }
      }

      const { count: billApprovalCount } = await supabase
        .from("vendor_bills")
        .select("*", { count: "exact", head: true })
        .eq("approval_status", "approved");
      const billApprovalCode = generateSignedApprovalCode("bill", (billApprovalCount ?? 0) + 1, id);

      const isPartialApproval = approvedAmt !== null && approvedAmt < Number(bill.total_amount);

      const batchDate = computeBatchDate(parsed.data.batch_type);

      // total_amount = base (pre-GST). gst_amount is entered directly by approver.
      const totalAmt = Number(bill.total_amount); // this IS the base
      const approveGstAmount = Math.round((parsed.data.gst_amount ?? 0) * 100) / 100;
      const maxAllowedGst = Math.round(totalAmt * 0.28 * 100) / 100;
      if (approveGstAmount > maxAllowedGst) {
        return NextResponse.json(
          { error: `GST amount (₹${approveGstAmount.toLocaleString("en-IN")}) exceeds the maximum allowed (28% of ₹${totalAmt.toLocaleString("en-IN")} = ₹${maxAllowedGst.toLocaleString("en-IN")}). Please verify the invoice.` },
          { status: 422 },
        );
      }

      // Zero-GST at approval must be explicitly confirmed
      if (approveGstAmount === 0 && !parsed.data.gst_zero_confirmed) {
        return NextResponse.json(
          { error: "Please confirm that this bill has no GST before approving." },
          { status: 422 },
        );
      }

      const approveNow = new Date().toISOString();
      updatePayload = {
        approval_status: "approved",
        approved_by: dbUser.id,
        approved_at: approveNow,
        approval_code: billApprovalCode,
        approved_amount: approvedAmt ?? totalAmt,
        approved_amount_note: parsed.data.approved_amount_note ?? null,
        rejection_reason: null,
        rejection_outcome: null,
        payment_batch_type: parsed.data.batch_type,
        payment_batch_date: toISODateString(batchDate),
        payment_batch_assigned_by: dbUser.id,
        payment_batch_assigned_at: approveNow,
        gst_rate: 0,
        gst_amount: approveGstAmount,
        base_amount: totalAmt,
        gst_set_by: dbUser.id,
        gst_set_at: approveNow,
        gst_zero_confirmed: approveGstAmount === 0,
        gst_zero_confirmed_by: approveGstAmount === 0 ? dbUser.id : null,
      };

      // For goods POs: advance status to invoice_approved
      if (bill.po_id) {
        const { data: linkedPo } = await supabase
          .from("purchase_orders")
          .select("po_type, status")
          .eq("id", bill.po_id)
          .single();
        if (linkedPo?.po_type !== "service" && linkedPo?.status === "invoice_received") {
          await supabase
            .from("purchase_orders")
            .update({ status: "invoice_approved" })
            .eq("id", bill.po_id);
        }
      }

      const approvalNote = isPartialApproval
        ? `${bill.bill_number} partially approved for ₹${approvedAmt?.toLocaleString("en-IN")} by ${dbUser.full_name ?? "manager"}`
        : `${bill.bill_number} approved by ${dbUser.full_name ?? "manager"}`;

      sendPushToProcurementRoles({
        title: isPartialApproval ? "Invoice Partially Approved" : "Invoice Approved",
        body: approvalNote,
        url: `/procurement/bills/${id}`,
        tag: `bill-approval-${id}`,
      }).catch((err) => console.error("[push] approve notification failed:", err));

      break;
    }

    case "override_batch": {
      // Any of: admin, manager, accounts can re-slot a batch date
      const canOverride = ["admin", "manager", "accounts"].includes(dbUser.role);
      if (!canOverride) {
        return NextResponse.json({ error: "Only admin, manager or accounts can change the payment batch" }, { status: 403 });
      }
      if (bill.approval_status !== "approved") {
        return NextResponse.json({ error: "Only approved bills can have their batch date changed" }, { status: 422 });
      }
      if (bill.payment_status === "paid") {
        return NextResponse.json({ error: "Paid bills cannot be re-scheduled" }, { status: 422 });
      }

      const newBatchDate = computeBatchDate(parsed.data.batch_type);
      const newBatchDateStr = toISODateString(newBatchDate);

      // Log the change before updating
      await supabase.from("vendor_bill_batch_changes").insert({
        vendor_bill_id: id,
        changed_by: dbUser.id,
        changed_at: new Date().toISOString(),
        old_batch_type: bill.payment_batch_type ?? null,
        new_batch_type: parsed.data.batch_type,
        old_batch_date: bill.payment_batch_date ?? null,
        new_batch_date: newBatchDateStr,
        reason: parsed.data.reason ?? null,
      });

      updatePayload = {
        payment_batch_type: parsed.data.batch_type,
        payment_batch_date: newBatchDateStr,
        payment_batch_assigned_by: dbUser.id,
        payment_batch_assigned_at: new Date().toISOString(),
      };
      break;
    }

    case "approve_balance": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin or manager can approve the remaining balance" }, { status: 403 });
      }
      if (bill.approval_status !== "approved") {
        return NextResponse.json({ error: "Bill must already be approved to extend balance approval" }, { status: 422 });
      }
      if (!bill.approved_amount || Number(bill.approved_amount) >= Number(bill.total_amount)) {
        return NextResponse.json({ error: "No balance pending approval — bill is already fully approved" }, { status: 422 });
      }

      updatePayload = {
        approved_amount: Number(bill.total_amount),
        approved_amount_note: null,
      };

      sendPushToProcurementRoles({
        title: "Invoice Balance Approved",
        body: `Remaining balance on ${bill.bill_number} approved for full payment`,
        url: `/procurement/bills/${id}`,
        tag: `bill-approval-${id}`,
      }).catch((err) => console.error("[push] balance approval notification failed:", err));

      break;
    }

    case "reject": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin or manager can reject bills" }, { status: 403 });
      }
      if (bill.approval_status !== "pending") {
        return NextResponse.json(
          { error: "Only pending bills can be rejected" },
          { status: 422 }
        );
      }

      // Determine PO type to decide outcome handling
      let poType: string | null = null;
      if (bill.po_id) {
        const { data: linkedPo } = await supabase
          .from("purchase_orders")
          .select("po_type, status")
          .eq("id", bill.po_id)
          .single();
        poType = linkedPo?.po_type ?? null;

        if (poType === "service") {
          // Service PO: void the bill (delete it so the cycle can accept a new invoice)
          await supabase.from("vendor_bills").delete().eq("id", id);

          await logAudit(supabase, {
            entityType: "vendor_bill",
            entityId: id,
            action: "delete",
            performedBy: dbUser.id,
            changes: {
              approval_status: { old: "pending", new: "rejected (voided)" },
              rejection_reason: { old: null, new: parsed.data.rejection_reason },
            },
          });

          sendPushToProcurementRoles({
            title: "Service Invoice Rejected",
            body: `${bill.bill_number} voided — a new invoice can be uploaded for this cycle`,
            url: bill.po_id ? `/procurement/orders/${bill.po_id}` : `/procurement/bills`,
            tag: `bill-approval-${id}`,
          }).catch((err) => console.error("[push] service rejection notification failed:", err));

          return NextResponse.json({
            data: null,
            message: "Invoice rejected and voided. A new invoice can be uploaded for this service cycle.",
          });
        }

      }

      updatePayload = {
        approval_status: "rejected",
        approved_by: dbUser.id,
        approved_at: new Date().toISOString(),
        rejection_reason: parsed.data.rejection_reason,
        rejection_outcome: null,
      };

      sendPushToProcurementRoles({
        title: "Invoice Rejected",
        body: `${bill.bill_number} rejected — ${parsed.data.rejection_reason}`,
        url: `/procurement/bills/${id}`,
        tag: `bill-approval-${id}`,
      }).catch((err) => console.error("[push] reject notification failed:", err));

      break;
    }

    case "hold_payment": {
      const canHold = ["admin", "accounts", "office_admin"].includes(dbUser.role);
      if (!canHold) {
        return NextResponse.json({ error: "Only accounts team can place a payment hold" }, { status: 403 });
      }
      if (bill.approval_status !== "approved") {
        return NextResponse.json({ error: "Only approved bills can be placed on hold" }, { status: 422 });
      }
      if (bill.payment_status === "paid") {
        return NextResponse.json({ error: "Already paid bills cannot be placed on hold" }, { status: 422 });
      }
      if (bill.payment_hold_status === "on_hold") {
        return NextResponse.json({ error: "Bill is already on hold" }, { status: 422 });
      }

      const holdData = parsed.data; // narrowed to hold_payment variant
      updatePayload = {
        payment_hold_status: "on_hold",
        payment_hold_reason: holdData.hold_reason,
        payment_hold_notes: holdData.hold_notes ?? null,
        payment_held_by: dbUser.id,
        payment_held_at: new Date().toISOString(),
        payment_hold_resolved_by: null,
        payment_hold_resolved_at: null,
        payment_hold_resolution_notes: null,
      };

      const holdReasonLabel = HOLD_REASON_LABELS[holdData.hold_reason] ?? holdData.hold_reason;

      // Notify all admin + manager users via in-app notifications
      const { data: approvers } = await supabase
        .from("users")
        .select("id")
        .in("role", ["admin", "manager"]);
      if (approvers && approvers.length > 0) {
        await supabase.from("notifications").insert(
          approvers.map((u: { id: string }) => ({
            user_id: u.id,
            type: "payment_hold",
            title: "Payment Placed on Hold",
            body: `${bill.bill_number} requires your attention — ${holdReasonLabel}`,
            url: `/accounting/vendor-payments/${id}`,
            entity_type: "vendor_bill",
            entity_id: id,
          }))
        );
      }

      sendPushToProcurementRoles({
        title: "Payment On Hold",
        body: `${bill.bill_number} — ${holdReasonLabel}. Approver action required.`,
        url: `/accounting/vendor-payments/${id}`,
        tag: `payment-hold-${id}`,
      }).catch((err) => console.error("[push] hold notification failed:", err));

      break;
    }

    case "release_hold": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin or manager can release a payment hold" }, { status: 403 });
      }
      if (bill.payment_hold_status !== "on_hold") {
        return NextResponse.json({ error: "Bill is not on hold" }, { status: 422 });
      }

      updatePayload = {
        payment_hold_status: "none",
        payment_hold_resolved_by: dbUser.id,
        payment_hold_resolved_at: new Date().toISOString(),
        payment_hold_resolution_notes: parsed.data.resolution_notes ?? null,
      };
      break;
    }

    case "update_gst": {
      // Allow admin, manager, and accounts to set GST (accounts needs it when processing payment)
      const canUpdateGst = ["admin", "manager", "accounts"].includes(dbUser.role);
      if (!canUpdateGst) {
        return NextResponse.json({ error: "Only admin, manager, or accounts can update GST on a bill" }, { status: 403 });
      }
      if (bill.payment_status === "paid") {
        return NextResponse.json({ error: "Cannot update GST on a fully paid bill" }, { status: 422 });
      }

      // total_amount = base (pre-GST). gst_amount is entered directly.
      const totalAmount = Number(bill.total_amount); // this IS the base
      const newGstAmount = Math.round((parsed.data.gst_amount ?? 0) * 100) / 100;
      const maxGst = Math.round(totalAmount * 0.28 * 100) / 100;
      if (newGstAmount > maxGst) {
        return NextResponse.json(
          { error: `GST amount (₹${newGstAmount.toLocaleString("en-IN")}) exceeds the maximum allowed (28% of ₹${totalAmount.toLocaleString("en-IN")} = ₹${maxGst.toLocaleString("en-IN")}). Please verify the invoice.` },
          { status: 422 },
        );
      }

      // Zero-GST must be explicitly confirmed by the user
      if (newGstAmount === 0 && !parsed.data.gst_zero_confirmed) {
        return NextResponse.json(
          { error: "Please confirm that this bill has no GST before applying a zero amount." },
          { status: 422 },
        );
      }

      const gstNow = new Date().toISOString();
      updatePayload = {
        gst_rate: 0,
        gst_amount: newGstAmount,
        base_amount: totalAmount, // base_amount = total_amount (same thing)
        gst_set_by: dbUser.id,
        gst_set_at: gstNow,
        gst_zero_confirmed: newGstAmount === 0,
        gst_zero_confirmed_by: newGstAmount === 0 ? dbUser.id : null,
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

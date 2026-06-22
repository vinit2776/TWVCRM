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
    /** Required when the payment is less than the approved outstanding (partial). */
    partial_reason: z.string().nullish(),
    tds: tdsSchema.nullish(),
    petty_cash_book_id: z.string().uuid().nullish(),
  }),
  z.object({
    action: z.literal("approve"),
    approved_amount: z.number().positive().nullish(),
    approved_amount_note: z.string().nullish(),
    /** Required when approved_amount < total_amount (partial approval). */
    approved_amount_reason: z.string().nullish(),
    batch_type: z.enum(["immediate", "15th", "25th"]),
    /** Optional at approval — accounts can set later via update_gst, but it is mandatory before payment. */
    gst_amount: z.number().min(0, "GST amount must be 0 or greater").optional(),
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
  z.object({
    action: z.literal("tag_accounting"),
    /** Department and expenditure type for direct-expense bills (no PO). */
    manual_department: z.enum(["pantry", "maintenance", "administration", "asset"]).nullish(),
    manual_expenditure_type: z.enum(["operational", "amc", "capital"]).nullish(),
  }),
  z.object({
    action: z.literal("update_due_date"),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD"),
  }),
  z.object({
    action: z.literal("sign_cheque"),
  }),
  z.object({
    /**
     * Lets a rejected bill have its (pre-GST) total_amount corrected and pushed back
     * into the approval queue. Common case: amount was entered GST-inclusive and the
     * admin rejected — instead of recreating, edit the amount and resubmit.
     */
    action: z.literal("update_amount_and_resubmit"),
    total_amount: z.number().positive("Amount must be greater than zero"),
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
  // Approval actions require admin only
  const canApproveOrReject = dbUser.role === "admin";

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
  // Extra audit-trail entries that don't come from the vendor_bills row diff
  // (e.g. partial_reason lives on vendor_bill_payments, but we want it
  // surfaced on the bill's audit timeline so investigators don't have to
  // join two tables to understand why a partial payment was recorded).
  const extraAuditChanges: Record<string, { old: unknown; new: unknown }> = {};

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

      // Mandatory GST gate: bill must have GST set (or explicit zero-GST confirmation) before any payment.
      // Approval no longer requires GST — it is captured here by accounts using the inline GST setter.
      if (!bill.gst_set_at) {
        return NextResponse.json(
          { error: "GST amount has not been set on this bill. Enter the GST from the vendor's invoice (or confirm zero-GST) before recording payment." },
          { status: 422 }
        );
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

      // Partial-payment clarity: if accounts is paying less than the full approved
      // outstanding, force them to pick a structured reason. Free-text detail can
      // still go in `notes`. Without this we lose the WHY at the only point where
      // the partial decision is being made.
      const isPartialPayment = parsed.data.amount < remainingApproved - 0.01;
      const partialReason = parsed.data.partial_reason?.trim() || null;
      if (isPartialPayment && !partialReason) {
        return NextResponse.json(
          { error: `You are recording ₹${parsed.data.amount.toFixed(2)} of ₹${remainingApproved.toFixed(2)} outstanding. Select a reason for the partial payment.` },
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
          partial_reason: partialReason,
          recorded_by: dbUser.id,
          petty_cash_book_id: parsed.data.petty_cash_book_id ?? null,
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

      // Debit the selected petty cash book when paying in cash (overdraft allowed)
      if (parsed.data.payment_mode === "cash" && parsed.data.petty_cash_book_id) {
        const { data: pcBook } = await supabase
          .from("petty_cash_books")
          .select("id, current_balance")
          .eq("id", parsed.data.petty_cash_book_id)
          .single();
        if (pcBook) {
          const newBalance = Number(pcBook.current_balance) - parsed.data.amount;
          await supabase
            .from("petty_cash_books")
            .update({ current_balance: newBalance })
            .eq("id", parsed.data.petty_cash_book_id);
        }
      }

      updatePayload = {
        amount_paid: newAmountPaid,
        payment_status: paymentStatus,
        payment_mode: parsed.data.payment_mode,
        payment_reference: parsed.data.payment_reference ?? null,
        payment_date: paymentDate,
      };
      if (isPartialPayment) {
        extraAuditChanges.partial_payment_reason = { old: null, new: partialReason };
        if (parsed.data.notes?.trim()) {
          extraAuditChanges.partial_payment_note = { old: null, new: parsed.data.notes.trim() };
        }
      }
      break;
    }

    case "approve": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin can approve bills" }, { status: 403 });
      }
      if (bill.approval_status !== "pending") {
        return NextResponse.json(
          { error: "Only pending bills can be approved" },
          { status: 422 }
        );
      }

      // Due date must be on or after today (the approval date).
      // An overdue due date means accounts would inherit a bill that was
      // already past its payment deadline the moment it was approved.
      if (bill.due_date) {
        const todayStr = new Date().toISOString().split("T")[0];
        if (bill.due_date < todayStr) {
          return NextResponse.json(
            {
              error: `Due date (${bill.due_date}) has already passed. Update the due date to today or later before approving.`,
              code: "due_date_in_past",
            },
            { status: 422 }
          );
        }
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
        // Partial approval clarity: require a structured reason + a note explaining WHY
        // the approver chose to release less than the full invoice value. Without this
        // the downstream Accounts team has no context for the smaller ceiling.
        const isPartial = approvedAmt < Number(bill.total_amount) - 0.01;
        if (isPartial) {
          const reason = parsed.data.approved_amount_reason?.trim() ?? "";
          const note = parsed.data.approved_amount_note?.trim() ?? "";
          if (!reason) {
            return NextResponse.json(
              { error: "Select a reason for the partial approval." },
              { status: 422 }
            );
          }
          if (!note) {
            return NextResponse.json(
              { error: "Add a short note explaining the partial approval (visible to Accounts)." },
              { status: 422 }
            );
          }
        }
      }

      const { count: billApprovalCount } = await supabase
        .from("vendor_bills")
        .select("*", { count: "exact", head: true })
        .eq("approval_status", "approved");
      const billApprovalCode = generateSignedApprovalCode("bill", (billApprovalCount ?? 0) + 1, id);

      const isPartialApproval = approvedAmt !== null && approvedAmt < Number(bill.total_amount);

      const batchDate = computeBatchDate(parsed.data.batch_type);

      // total_amount = base (pre-GST). gst_amount is OPTIONAL at approval — accounts can set it
      // later via update_gst before recording payment.
      const totalAmt = Number(bill.total_amount); // this IS the base
      const gstProvided = parsed.data.gst_amount !== undefined;
      const approveGstAmount = gstProvided ? Math.round((parsed.data.gst_amount ?? 0) * 100) / 100 : null;

      if (approveGstAmount !== null) {
        const maxAllowedGst = Math.round(totalAmt * 0.28 * 100) / 100;
        if (approveGstAmount > maxAllowedGst) {
          return NextResponse.json(
            { error: `GST amount (₹${approveGstAmount.toLocaleString("en-IN")}) exceeds the maximum allowed (28% of ₹${totalAmt.toLocaleString("en-IN")} = ₹${maxAllowedGst.toLocaleString("en-IN")}). Please verify the invoice.` },
            { status: 422 },
          );
        }
        // Zero-GST at approval (when GST is being set here) must be explicitly confirmed
        if (approveGstAmount === 0 && !parsed.data.gst_zero_confirmed) {
          return NextResponse.json(
            { error: "Please confirm that this bill has no GST before approving." },
            { status: 422 },
          );
        }
      }

      const approveNow = new Date().toISOString();
      updatePayload = {
        approval_status: "approved",
        approved_by: dbUser.id,
        approved_at: approveNow,
        approval_code: billApprovalCode,
        approved_amount: approvedAmt ?? totalAmt,
        approved_amount_note: parsed.data.approved_amount_note ?? null,
        approved_amount_reason: isPartialApproval ? (parsed.data.approved_amount_reason ?? null) : null,
        rejection_reason: null,
        rejection_outcome: null,
        payment_batch_type: parsed.data.batch_type,
        payment_batch_date: toISODateString(batchDate),
        payment_batch_assigned_by: dbUser.id,
        payment_batch_assigned_at: approveNow,
        base_amount: totalAmt,
        // Only stamp GST fields if approver actually entered a value.
        // Otherwise leave them null — accounts must set GST before recording payment.
        ...(approveGstAmount !== null
          ? {
              gst_rate: 0,
              gst_amount: approveGstAmount,
              gst_set_by: dbUser.id,
              gst_set_at: approveNow,
              gst_zero_confirmed: approveGstAmount === 0,
              gst_zero_confirmed_by: approveGstAmount === 0 ? dbUser.id : null,
            }
          : {}),
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
        return NextResponse.json({ error: "Only admin can approve the remaining balance" }, { status: 403 });
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
        return NextResponse.json({ error: "Only admin can reject bills" }, { status: 403 });
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
        return NextResponse.json({ error: "Only admin can release a payment hold" }, { status: 403 });
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

    case "tag_accounting": {
      // Admin, manager, and accounts can tag direct-expense bills with dept + exp-type
      const canTag = ["admin", "manager", "accounts", "office_admin"].includes(dbUser.role);
      if (!canTag) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      updatePayload = {
        manual_department: parsed.data.manual_department ?? null,
        manual_expenditure_type: parsed.data.manual_expenditure_type ?? null,
      };
      break;
    }

    case "update_due_date": {
      // Any approver or accounts role can update the due date on a pending bill.
      // This exists so they can fix a stale due date before approving, without
      // having to reject and re-upload the bill.
      const canUpdateDueDate = ["admin", "manager", "accounts", "office_admin"].includes(dbUser.role);
      if (!canUpdateDueDate) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (bill.approval_status === "paid") {
        return NextResponse.json({ error: "Cannot change the due date on a fully paid bill" }, { status: 422 });
      }
      const todayStr = new Date().toISOString().split("T")[0];
      if (parsed.data.due_date < todayStr) {
        return NextResponse.json(
          { error: "Due date must be today or a future date" },
          { status: 422 }
        );
      }
      updatePayload = { due_date: parsed.data.due_date };
      break;
    }

    case "sign_cheque": {
      if (!["admin", "accounts", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (bill.payment_mode !== "cheque") {
        return NextResponse.json({ error: "This bill was not paid by cheque" }, { status: 422 });
      }
      if (bill.cheque_signed_at) {
        return NextResponse.json({ error: "Cheque has already been signed" }, { status: 422 });
      }
      if (bill.payment_status === "unpaid") {
        return NextResponse.json({ error: "No payment has been recorded yet" }, { status: 422 });
      }
      const signedAt = new Date().toISOString();
      // Sign this bill
      const { error: signErr } = await supabase
        .from("vendor_bills")
        .update({ cheque_signed_at: signedAt, cheque_signed_by: dbUser.id })
        .eq("id", id);
      if (signErr) return NextResponse.json({ error: signErr.message }, { status: 500 });
      await logAudit(supabase, {
        entityType: "vendor_bill",
        entityId: id,
        action: "cheque_signed",
        performedBy: dbUser.id,
        changes: {
          cheque_signed_at: { old: null, new: signedAt },
          cheque_signed_by: { old: null, new: dbUser.id },
        },
      });

      // Also sign all other unsigned bills from the same vendor with the same cheque number.
      // One physical cheque = one signing action — no need to visit each bill individually.
      let siblingsUpdated = 0;
      if (bill.payment_reference && bill.vendor_id) {
        const { data: siblings } = await supabase
          .from("vendor_bills")
          .select("id")
          .eq("vendor_id", bill.vendor_id)
          .eq("payment_reference", bill.payment_reference)
          .eq("payment_mode", "cheque")
          .is("cheque_signed_at", null)
          .neq("id", id);

        if (siblings && siblings.length > 0) {
          const siblingIds = siblings.map((s: { id: string }) => s.id);
          await supabase
            .from("vendor_bills")
            .update({ cheque_signed_at: signedAt, cheque_signed_by: dbUser.id })
            .in("id", siblingIds);
          // Audit each sibling (fire-and-forget)
          for (const siblingId of siblingIds) {
            logAudit(supabase, {
              entityType: "vendor_bill",
              entityId: siblingId,
              action: "cheque_signed",
              performedBy: dbUser.id,
              changes: {
                cheque_signed_at: { old: null, new: signedAt },
                cheque_signed_by: { old: null, new: dbUser.id },
                note: { old: null, new: `Auto-signed with bill ${id} (same cheque)` },
              },
            });
          }
          siblingsUpdated = siblingIds.length;
        }
      }

      return NextResponse.json({
        message: siblingsUpdated > 0
          ? `Cheque marked as signed (${siblingsUpdated + 1} bills on this cheque updated)`
          : "Cheque marked as signed",
      });
    }

    case "update_amount_and_resubmit": {
      // Lets a rejected bill have its (pre-GST) total_amount corrected and routed back
      // to approval. Any procurement role can do this (no requester-only gate).
      if (bill.approval_status !== "rejected") {
        return NextResponse.json(
          { error: "Only rejected bills can be edited and resubmitted" },
          { status: 422 }
        );
      }
      const newTotal = Math.round(parsed.data.total_amount * 100) / 100;

      // Re-validate against PO ceiling (mirrors creation rule). Skip when there is no PO.
      if (bill.po_id) {
        const { data: linkedPo } = await supabase
          .from("purchase_orders")
          .select("po_type, total_amount, unit_cost_per_cycle")
          .eq("id", bill.po_id)
          .single();
        if (linkedPo) {
          const ceiling = linkedPo.po_type === "service" && linkedPo.unit_cost_per_cycle
            ? Number(linkedPo.unit_cost_per_cycle)
            : Number(linkedPo.total_amount ?? 0);
          if (ceiling > 0 && newTotal > ceiling) {
            return NextResponse.json(
              {
                error: `Corrected amount (₹${newTotal.toLocaleString("en-IN")}) cannot exceed the ${linkedPo.po_type === "service" ? "cycle cost" : "PO value"} (₹${ceiling.toLocaleString("en-IN")})`,
              },
              { status: 422 }
            );
          }
        }
      }

      // Clear stale GST fields — the previously-set GST (if any) was relative to the
      // wrong amount, so it must be re-captured. The "not yet set" sentinel is
      // gst_set_at IS NULL; numeric gst columns are NOT NULL with default 0 in the
      // DB, so we reset them to 0 (not null) to avoid a constraint violation.
      updatePayload = {
        total_amount: newTotal,
        approval_status: "pending",
        approved_by: null,
        approved_at: null,
        approval_code: null,
        approved_amount: null,
        approved_amount_note: null,
        rejection_reason: null,
        rejection_outcome: null,
        payment_batch_type: null,
        payment_batch_date: null,
        payment_batch_assigned_by: null,
        payment_batch_assigned_at: null,
        base_amount: newTotal,
        gst_rate: 0,
        gst_amount: 0,
        gst_set_by: null,
        gst_set_at: null,
        gst_zero_confirmed: false,
        gst_zero_confirmed_by: null,
      };

      sendPushToProcurementRoles({
        title: "Bill amount corrected — needs re-approval",
        body: `${bill.bill_number}: ₹${Number(bill.total_amount).toLocaleString("en-IN")} → ₹${newTotal.toLocaleString("en-IN")}`,
        url: `/procurement/bills/${id}`,
        tag: `bill-approval-${id}`,
      }).catch((err) => console.error("[push] resubmit notification failed:", err));

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
    changes: {
      ...diffChanges(bill as Record<string, unknown>, { ...bill, ...updatePayload } as Record<string, unknown>),
      ...extraAuditChanges,
    },
  });

  return NextResponse.json({ data: updated });
}

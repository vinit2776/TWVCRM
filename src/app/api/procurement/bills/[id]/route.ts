import { chainLockedResponse } from "@/lib/procurement/chain-lock";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { sendPushToProcurementRoles } from "@/lib/push";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";
import { computeBatchDate, toISODateString } from "@/lib/payment-batch";
import { confirmFirstBillIfNeeded } from "@/lib/procurement/recurring-bill-rules-server";
import { z } from "zod";
import { checkTieInvoiceToCycle } from "@/lib/procurement/tie-invoice";
import { canRollback, rollbackReasonSchema } from "@/lib/procurement/admin-rollback";
import { poStatusAfterWithdraw } from "@/lib/procurement/po-status-after-withdraw";
import {
  approvalAfterAmountChange,
  billEditLockReason,
  canEditBill,
  classifyAmountChange,
} from "@/lib/procurement/bill-edit-rules";
import {
  checkBillAmountAgainstPo,
  countStandingPayments,
  replyOnOpenBillQueries,
} from "@/lib/procurement/bill-edit-server";

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
    /** Admin rollback: an approved, unpaid bill goes back to the approval queue. */
    action: z.literal("unapprove"),
    reason: rollbackReasonSchema,
  }),
  z.object({
    /** Admin rollback: pull back a pending/rejected bill (wrong PO, duplicate upload…). */
    action: z.literal("withdraw"),
    reason: rollbackReasonSchema,
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
    /** Required when the bill is outside its PO's price tolerance. */
    acknowledge_out_of_tolerance: z.boolean().optional(),
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
    /**
     * Corrects the base (pre-GST) amount on an already-approved bill when it
     * doesn't match the vendor's invoice. Re-approves in full at the corrected
     * figure — there is no other path to change approved_amount once approved
     * (reject only works on pending bills; approve_balance only raises to the
     * original total_amount).
     */
    action: z.literal("correct_approved_amount"),
    total_amount: z.number().positive("Amount must be greater than zero"),
    reason: z.string().min(1, "A reason is required for correcting the approved amount"),
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
    /** Admin rollback: a cheque marked signed by mistake (also clears bills signed with it). */
    action: z.literal("unsign_cheque"),
    reason: rollbackReasonSchema,
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
  z.object({
    /**
     * Ties an untied invoice on a service PO to one of its service-report cycles.
     * Admin only — repairs invoices uploaded before the contract had cycle billing.
     */
    action: z.literal("link_service_report"),
    service_report_id: z.string().uuid(),
  }),
  z.object({
    /**
     * Corrects a wrong invoice upload (wrong file, misread number/date/amount) at any
     * point before a payment is recorded — including approved-but-unpaid. Once a
     * payment stands the bill is locked (admin Correct menu only).
     */
    action: z.literal("edit_invoice_details"),
    invoice_number: z.string().nullish(),
    invoice_date: z.string().min(1, "Invoice date is required"),
    due_date: z.string().nullish(),
    total_amount: z.number().positive("Total amount must be greater than 0"),
    notes: z.string().nullish(),
    invoice_file_url: z.string().url().nullish(),
    /** Required when the bill is already approved — shown to Accounts and on the query thread. */
    reason: z.string().trim().max(500).nullish(),
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
       purchase_orders(id, po_number, status, po_type, tolerance_percent, total_ordered_amount, unit_cost_per_cycle, advance_status, advance_amount, advance_payment_mode, advance_payment_reference, advance_payment_date),
       approver:users!vendor_bills_approved_by_fkey(id, full_name),
       vendor_bill_payments(id, amount, payment_mode, payment_reference, payment_date, notes, created_at, reversed_at, reversal_reason, recorder:users!vendor_bill_payments_recorded_by_fkey(id, full_name)),
       vendor_bill_batch_changes(id, changed_at, old_batch_type, new_batch_type, old_batch_date, new_batch_date, reason, changer:users!vendor_bill_batch_changes_changed_by_fkey(id, full_name)),
       vendor_bill_documents(id, file_url, file_name, doc_type, created_at, uploader:users!vendor_bill_documents_uploaded_by_fkey(id, full_name)),
       electricity_bill:electricity_bills!vendor_bills_electricity_bill_id_fkey(bill_month, bill_year, landlord_total_amount, landlord_gst_applicable, landlord_gst_rate, landlord_gst_amount, electricity_bill_lines(line_type, meter_label, label, units, rate, amount, sort_order))`
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

  const { data: bill, error: fetchError } = await supabase
    .from("vendor_bills")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  // The bill's own creator can always act on it (e.g. fix and resubmit a
  // rejection) even if their role isn't in the general procurement list —
  // mirrors the requester bypass on the Material Request PATCH route.
  const canAct = ["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)
    || bill.created_by === dbUser.id;
  if (!canAct) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  // Approval actions require admin only
  const canApproveOrReject = dbUser.role === "admin";

  // A withdrawn bill is frozen history: nothing on it can change (GST, due
  // date, cheque, invoice details...). It can't be revived — upload a fresh bill.
  if (bill.approval_status === "withdrawn") {
    return NextResponse.json(
      { error: "This bill was withdrawn and can no longer be changed. Upload a new bill if it is still needed." },
      { status: 422 }
    );
  }

  // A closed cycle is read-only until an admin reopens it (see chain-lock.ts).
  const lockedChain = await chainLockedResponse(supabase, { billId: id });
  if (lockedChain) return lockedChain;

  const body = await request.json();
  const parsed = patchBillSchema.safeParse(body);
  if (!parsed.success) {
    // `error` must always be a string — clients render it directly in toasts,
    // and an object here crashes React ("Objects are not valid as a React child").
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const message = Object.entries(fieldErrors)
      .map(([field, errs]) => `${field}: ${(errs ?? []).join(", ")}`)
      .join("; ") || "Invalid request";
    return NextResponse.json({ error: message, details: fieldErrors }, { status: 400 });
  }

  let updatePayload: Record<string, unknown> = {};
  // Extra audit-trail entries that don't come from the vendor_bills row diff
  // (e.g. partial_reason lives on vendor_bill_payments, but we want it
  // surfaced on the bill's audit timeline so investigators don't have to
  // join two tables to understand why a partial payment was recorded).
  const extraAuditChanges: Record<string, { old: unknown; new: unknown }> = {};
  let extraPoChange: { old: string; new: string } | null = null;
  // Side effects that must only run once the bill row itself has been updated.
  let afterBillUpdate: (() => Promise<void>) | null = null;
  // Set by edit_invoice_details when the invoice file itself was replaced —
  // keeps the vendor_bill_documents "invoice" row in sync so the Supporting
  // Documents list (seeded from invoice_file_url at migration time) doesn't
  // go stale next to the column this same action already updates.
  let syncedInvoiceFileUrl: string | null = null;

  switch (parsed.data.action) {
    case "record_payment": {
      // Role-based payment mode gate
      // - accounts: all modes (bank + cash/petty cash)
      // - admin: all modes
      // - office_admin: cash only (petty cash)
      // - everyone else: no payment access
      const mode = parsed.data.payment_mode;
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

      // Mandatory GST gate: GST must have been entered before any payment.
      // A bill edit clears gst_set_at but preserves gst_amount — that existing
      // value is still valid, so we accept it without requiring re-confirmation.
      const gstConfigured = bill.gst_set_at || Number(bill.gst_amount ?? 0) > 0 || bill.gst_zero_confirmed;
      if (!gstConfigured) {
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

    case "withdraw": {
      if (!canRollback(dbUser.role)) {
        return NextResponse.json({ error: "Only an admin can withdraw a bill" }, { status: 403 });
      }
      if (bill.approval_status === "approved") {
        return NextResponse.json(
          { error: "This bill is approved. Reverse its payments and un-approve it first, then withdraw." },
          { status: 422 }
        );
      }
      if (bill.approval_status !== "pending" && bill.approval_status !== "rejected") {
        return NextResponse.json({ error: "Only pending or rejected bills can be withdrawn" }, { status: 422 });
      }
      // An electricity-capture bill is tied to the electricity bill it came
      // from (and the customer charges raised off it); withdrawing only the
      // vendor side would orphan those.
      if (bill.electricity_bill_id) {
        return NextResponse.json(
          { error: "This bill was created from an electricity bill. Remove it from the Electricity page instead." },
          { status: 422 }
        );
      }
      const { count: standingPayments } = await supabase
        .from("vendor_bill_payments")
        .select("*", { count: "exact", head: true })
        .eq("bill_id", id)
        .is("reversed_at", null);
      if ((standingPayments ?? 0) > 0) {
        return NextResponse.json({ error: "This bill has payments recorded. Reverse them first." }, { status: 422 });
      }

      const withdrawnAt = new Date().toISOString();
      updatePayload = {
        approval_status: "withdrawn",
        withdrawn_at: withdrawnAt,
        withdrawn_by: dbUser.id,
        withdrawn_reason: parsed.data.reason,
        rejection_outcome: null,
        approval_code: null,
        approved_by: null,
        approved_at: null,
        payment_batch_type: null,
        payment_batch_date: null,
        payment_batch_assigned_by: null,
        payment_batch_assigned_at: null,
        payment_hold_status: "none",
      };
      extraAuditChanges.rollback_kind = { old: null, new: "bill_withdrawn" };
      extraAuditChanges.rollback_reason = { old: null, new: parsed.data.reason };

      afterBillUpdate = async () => {
        // A recurring rule that treated this as its established first bill must
        // review the next one again.
        await supabase
          .from("procurement_recurring_bill_rules")
          .update({ first_bill_id: null })
          .eq("first_bill_id", id);

        if (!bill.po_id) return;
        const { data: po } = await supabase
          .from("purchase_orders")
          .select("po_type, status")
          .eq("id", bill.po_id)
          .single();
        if (!po) return;
        const [{ data: otherBills }, { data: items }] = await Promise.all([
          supabase.from("vendor_bills").select("approval_status").eq("po_id", bill.po_id).neq("id", id),
          supabase.from("purchase_order_items").select("quantity_ordered, quantity_received").eq("po_id", bill.po_id),
        ]);
        const next = poStatusAfterWithdraw({
          poType: po.po_type,
          poStatus: po.status,
          statusBeforeBill: bill.po_status_before_bill ?? null,
          otherBills: otherBills ?? [],
          items: items ?? [],
        });
        if (next && next !== po.status) {
          await supabase.from("purchase_orders").update({ status: next }).eq("id", bill.po_id);
          extraPoChange = { old: po.status, new: next };
        }
      };
      break;
    }

    case "unapprove": {
      if (!canRollback(dbUser.role)) {
        return NextResponse.json({ error: "Only an admin can reverse an approval" }, { status: 403 });
      }
      if (bill.approval_status !== "approved") {
        return NextResponse.json({ error: "Only approved bills can be un-approved" }, { status: 422 });
      }
      // Rolling back goes one step at a time: a standing payment must be
      // reversed first, otherwise the bill would be unapproved yet part-paid.
      const { count: standingPayments } = await supabase
        .from("vendor_bill_payments")
        .select("*", { count: "exact", head: true })
        .eq("bill_id", id)
        .is("reversed_at", null);
      if ((standingPayments ?? 0) > 0) {
        return NextResponse.json(
          { error: "This bill has payments recorded. Reverse them first, then un-approve." },
          { status: 422 }
        );
      }

      // Mirrors the approval block reset in update_amount_and_resubmit. GST is
      // kept: the amount is unchanged, so the figure entered from the invoice
      // is still right.
      updatePayload = {
        approval_status: "pending",
        approved_by: null,
        approved_at: null,
        approval_code: null,
        approved_amount: null,
        approved_amount_note: null,
        approved_amount_reason: null,
        payment_batch_type: null,
        payment_batch_date: null,
        payment_batch_assigned_by: null,
        payment_batch_assigned_at: null,
        payment_hold_status: "none",
      };
      extraAuditChanges.rollback_kind = { old: null, new: "approval_reversed" };
      extraAuditChanges.rollback_reason = { old: null, new: parsed.data.reason };

      // Goods PO: approving moved it to invoice_approved; put it back.
      if (bill.po_id) {
        const { data: linkedPo } = await supabase
          .from("purchase_orders")
          .select("po_type, status")
          .eq("id", bill.po_id)
          .single();
        if (linkedPo?.po_type !== "service" && linkedPo?.status === "invoice_approved") {
          await supabase.from("purchase_orders").update({ status: "invoice_received" }).eq("id", bill.po_id);
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

      // A bill outside its PO's price tolerance needs the admin to confirm they saw the variance.
      if (bill.out_of_tolerance && !parsed.data.acknowledge_out_of_tolerance) {
        return NextResponse.json(
          {
            error: `Invoiced total on this PO is ${Math.abs(Number(bill.variance_percent ?? 0))}% ${Number(bill.variance_amount ?? 0) >= 0 ? "above" : "below"} the PO value, outside its agreed tolerance. Confirm you've reviewed the variance to approve it.`,
            code: "TOLERANCE_ACK_REQUIRED",
          },
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
        ...(bill.out_of_tolerance
          ? { tolerance_acknowledged_by: dbUser.id, tolerance_acknowledged_at: approveNow }
          : {}),
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

      // If this vendor has an active recurring rule still waiting on its first
      // post-rule confirmation, this manual approval establishes it — every
      // later bill against the rule becomes eligible to auto-approve.
      await confirmFirstBillIfNeeded(supabase, id, bill.vendor_id);

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

    case "correct_approved_amount": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin can correct an approved bill's amount" }, { status: 403 });
      }
      if (bill.approval_status !== "approved") {
        return NextResponse.json({ error: "Only approved bills can have their amount corrected" }, { status: 422 });
      }
      if (bill.payment_status === "paid") {
        return NextResponse.json({ error: "This bill is already fully paid — the amount can no longer be corrected" }, { status: 422 });
      }

      const correctedTotal = parsed.data.total_amount;
      const gstAmount = Number(bill.gst_amount ?? 0);
      const alreadyPaid = Number(bill.amount_paid ?? 0);
      const newCeiling = correctedTotal + gstAmount;
      if (alreadyPaid > newCeiling + 0.01) {
        return NextResponse.json(
          {
            error: `Corrected amount (₹${correctedTotal.toFixed(2)} + ₹${gstAmount.toFixed(2)} GST = ₹${newCeiling.toFixed(2)}) is less than the ₹${alreadyPaid.toFixed(2)} already paid on this bill.`,
          },
          { status: 422 }
        );
      }

      const correctionReason = parsed.data.reason.trim();
      updatePayload = {
        total_amount: correctedTotal,
        approved_amount: correctedTotal,
        approved_amount_note: null,
        approved_amount_reason: null,
      };
      extraAuditChanges.amount_correction_reason = { old: null, new: correctionReason };

      // Notify the Accounts / Office Admin users who actually record payment —
      // the correction is what unblocks them, unlike hold_payment which notifies admin/manager.
      const { data: accountsUsers } = await supabase
        .from("users")
        .select("id")
        .in("role", ["accounts", "office_admin"]);
      if (accountsUsers && accountsUsers.length > 0) {
        await supabase.from("notifications").insert(
          accountsUsers.map((u: { id: string }) => ({
            user_id: u.id,
            type: "bill_amount_corrected",
            title: "Approved Amount Corrected",
            body: `${bill.bill_number} corrected to ₹${correctedTotal.toLocaleString("en-IN")} — ${correctionReason}`,
            url: `/accounting/vendor-payments/${id}`,
            entity_type: "vendor_bill",
            entity_id: id,
          }))
        );
      }

      sendPushToProcurementRoles({
        title: "Bill Amount Corrected",
        body: `${bill.bill_number} corrected to ₹${correctedTotal.toLocaleString("en-IN")}`,
        url: `/accounting/vendor-payments/${id}`,
        tag: `bill-amount-corrected-${id}`,
      }).catch((err) => console.error("[push] amount correction notification failed:", err));

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

    case "link_service_report": {
      const [{ data: linkPo }, { data: linkReport }, { count: billsOnReport }] = await Promise.all([
        bill.po_id
          ? supabase.from("purchase_orders").select("po_type, status, unit_cost_per_cycle, amc_terminated_at").eq("id", bill.po_id).single()
          : Promise.resolve({ data: null }),
        supabase.from("po_service_reports").select("id, po_id").eq("id", parsed.data.service_report_id).maybeSingle(),
        supabase.from("vendor_bills").select("id", { count: "exact", head: true }).eq("service_report_id", parsed.data.service_report_id).not("approval_status", "in", DEAD_BILL_STATUSES_FILTER),
      ]);
      const verdict = checkTieInvoiceToCycle({
        role: dbUser.role,
        bill,
        po: linkPo,
        report: linkReport,
        billsOnReport: billsOnReport ?? 0,
        billPoId: bill.po_id,
      });
      if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });
      updatePayload = { service_report_id: parsed.data.service_report_id };
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

    case "unsign_cheque": {
      if (!canRollback(dbUser.role)) {
        return NextResponse.json({ error: "Only an admin can un-sign a cheque" }, { status: 403 });
      }
      if (!bill.cheque_signed_at) {
        return NextResponse.json({ error: "This cheque has not been signed" }, { status: 422 });
      }
      const signedAtWas = bill.cheque_signed_at as string;
      const unsignReason = parsed.data.reason;
      updatePayload = { cheque_signed_at: null, cheque_signed_by: null };
      extraAuditChanges.rollback_kind = { old: null, new: "cheque_unsigned" };
      extraAuditChanges.rollback_reason = { old: null, new: unsignReason };

      // One physical cheque can cover several bills and signing marks them all
      // together (same vendor, reference and signing moment) — clear them together.
      afterBillUpdate = async () => {
        if (!bill.payment_reference || !bill.vendor_id) return;
        const { data: siblings } = await supabase
          .from("vendor_bills")
          .update({ cheque_signed_at: null, cheque_signed_by: null })
          .eq("vendor_id", bill.vendor_id)
          .eq("payment_reference", bill.payment_reference)
          .eq("payment_mode", "cheque")
          .eq("cheque_signed_at", signedAtWas)
          .neq("id", id)
          .select("id");
        for (const s of siblings ?? []) {
          logAudit(supabase, {
            entityType: "vendor_bill",
            entityId: s.id,
            action: "rollback",
            performedBy: dbUser.id,
            changes: {
              rollback_kind: { old: null, new: "cheque_unsigned" },
              rollback_reason: { old: null, new: unsignReason },
              cheque_signed_at: { old: signedAtWas, new: null },
              note: { old: null, new: `Un-signed with bill ${id} (same cheque)` },
            },
          });
        }
      };
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
      if (!canEditBill({ role: dbUser.role, userId: dbUser.id, createdBy: bill.created_by })) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (bill.approval_status !== "rejected") {
        return NextResponse.json(
          { error: "Only rejected bills can be edited and resubmitted" },
          { status: 422 }
        );
      }
      const newTotal = Math.round(parsed.data.total_amount * 100) / 100;

      const ceilingCheck = await checkBillAmountAgainstPo(supabase, bill, newTotal);
      if (!ceilingCheck.ok) {
        return NextResponse.json({ error: ceilingCheck.error }, { status: 422 });
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

    case "edit_invoice_details": {
      // The bill's creator (any role), office_admin, manager and admin. Not accounts —
      // they pay the bill and raise a query when something looks wrong.
      if (!canEditBill({ role: dbUser.role, userId: dbUser.id, createdBy: bill.created_by })) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      const lockReason = billEditLockReason({
        approvalStatus: bill.approval_status,
        standingPaymentCount: await countStandingPayments(supabase, id),
        paymentStatus: bill.payment_status,
        chequeSigned: !!bill.cheque_signed_at,
      });
      if (lockReason) {
        return NextResponse.json({ error: lockReason }, { status: 422 });
      }

      const newTotal = Math.round(parsed.data.total_amount * 100) / 100;
      const oldTotal = Number(bill.total_amount ?? 0);
      const amountChange = classifyAmountChange(oldTotal, newTotal);
      const wasApproved = bill.approval_status === "approved";
      const changeReason = parsed.data.reason?.trim() || null;
      if (wasApproved && (!changeReason || changeReason.length < 5)) {
        return NextResponse.json(
          { error: "This bill is already approved. Add a short reason for the correction (it is shown to Accounts)." },
          { status: 422 }
        );
      }

      // Re-validate against the PO (value or cycle cost, plus price tolerance). Skip when there is no PO.
      const ceilingCheck = await checkBillAmountAgainstPo(supabase, bill, newTotal);
      if (!ceilingCheck.ok) {
        return NextResponse.json({ error: ceilingCheck.error }, { status: 422 });
      }

      // Duplicate invoice-number guard (mirrors creation), excluding this bill itself.
      const trimmedInvoiceNumber = parsed.data.invoice_number?.trim() || null;
      if (trimmedInvoiceNumber) {
        const { count: dupCount } = await supabase
          .from("vendor_bills")
          .select("*", { count: "exact", head: true })
          .eq("vendor_id", bill.vendor_id)
          .eq("invoice_number", trimmedInvoiceNumber)
          .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER)
          .neq("id", id);
        if (dupCount && dupCount > 0) {
          return NextResponse.json(
            { error: `Invoice number "${trimmedInvoiceNumber}" already exists for this vendor. Check Vendor Payments to avoid duplicate processing.` },
            { status: 409 }
          );
        }
      }

      // A corrected upload on a previously rejected bill re-enters the approval
      // queue — otherwise it would sit "rejected" forever with nobody to review it.
      const wasRejected = bill.approval_status === "rejected";
      // An approved bill whose amount goes UP needs the approver to look again;
      // lowered or unchanged keeps the approval (the approver agreed to pay at least this much).
      const resetsApproval = wasRejected || approvalAfterAmountChange(bill.approval_status, amountChange) === "reset";

      // A new file was actually uploaded (not just re-saving the same one) —
      // flag it so the vendor_bill_documents "invoice" row gets updated too,
      // after the main vendor_bills update below succeeds.
      if (parsed.data.invoice_file_url && parsed.data.invoice_file_url !== bill.invoice_file_url) {
        syncedInvoiceFileUrl = parsed.data.invoice_file_url;
      }

      // The base amount changed, so GST that was captured against the old one is
      // stale and must be re-entered. numeric gst columns are NOT NULL default 0.
      const clearGst = {
        gst_rate: 0,
        gst_amount: 0,
        gst_set_by: null,
        gst_set_at: null,
        gst_zero_confirmed: false,
        gst_zero_confirmed_by: null,
      };
      const tolerance = ceilingCheck.outcome;
      const toleranceFacts = tolerance.kind === "ok"
        ? { variance_amount: null, variance_percent: null, out_of_tolerance: false }
        : { variance_amount: tolerance.varianceAmount, variance_percent: tolerance.variancePercent, out_of_tolerance: tolerance.kind === "exception" };

      const oldApproved = bill.approved_amount === null || bill.approved_amount === undefined ? null : Number(bill.approved_amount);
      // A full approval follows the corrected figure; a partial one never exceeds it.
      const keptApprovedAmount = oldApproved === null
        ? null
        : Math.abs(oldApproved - oldTotal) < 0.01 ? newTotal : Math.min(oldApproved, newTotal);

      updatePayload = {
        invoice_number: trimmedInvoiceNumber,
        invoice_date: parsed.data.invoice_date,
        due_date: parsed.data.due_date ?? null,
        total_amount: newTotal,
        base_amount: newTotal,
        invoice_file_url: parsed.data.invoice_file_url ?? bill.invoice_file_url,
        notes: parsed.data.notes ?? null,
        ...(amountChange !== "unchanged" ? { ...clearGst, ...toleranceFacts } : {}),
        ...(wasApproved && !resetsApproval ? { approved_amount: keptApprovedAmount } : {}),
        ...(resetsApproval
          ? {
              approval_status: "pending",
              approved_by: null,
              approved_at: null,
              approval_code: null,
              approved_amount: null,
              approved_amount_note: null,
              approved_amount_reason: null,
              rejection_reason: null,
              rejection_outcome: null,
              payment_batch_type: null,
              payment_batch_date: null,
              payment_batch_assigned_by: null,
              payment_batch_assigned_at: null,
              payment_hold_status: "none",
              ...clearGst,
            }
          : {}),
      };

      if (changeReason) {
        extraAuditChanges.correction_reason = { old: null, new: changeReason };
      }
      if (wasApproved) {
        extraAuditChanges.correction_after_approval = {
          old: oldTotal,
          new: resetsApproval ? `${newTotal} (sent back for re-approval)` : newTotal,
        };
      }

      const changedBits: string[] = [];
      if (amountChange !== "unchanged") {
        changedBits.push(`amount ₹${oldTotal.toLocaleString("en-IN")} → ₹${newTotal.toLocaleString("en-IN")} (pre-GST)`);
      }
      if ((trimmedInvoiceNumber ?? null) !== (bill.invoice_number ?? null)) changedBits.push("invoice number");
      if (parsed.data.invoice_date !== bill.invoice_date) changedBits.push("invoice date");
      if ((parsed.data.due_date ?? null) !== (bill.due_date ?? null)) changedBits.push("due date");
      if (syncedInvoiceFileUrl) changedBits.push("invoice file");
      const summary = changedBits.length > 0 ? changedBits.join(", ") : "details re-saved";

      if (resetsApproval) {
        // Goods PO: approval had moved it to invoice_approved; put it back (mirrors unapprove).
        if (wasApproved && bill.po_id) {
          const { data: linkedPo } = await supabase
            .from("purchase_orders")
            .select("po_type, status")
            .eq("id", bill.po_id)
            .single();
          if (linkedPo?.po_type !== "service" && linkedPo?.status === "invoice_approved") {
            await supabase.from("purchase_orders").update({ status: "invoice_received" }).eq("id", bill.po_id);
          }
        }
        sendPushToProcurementRoles({
          title: wasApproved ? "Bill amount raised — needs re-approval" : "Invoice corrected — needs re-approval",
          body: `${bill.bill_number} corrected and resubmitted for approval`,
          url: `/procurement/bills/${id}`,
          tag: `bill-approval-${id}`,
        }).catch((err) => console.error("[push] resubmit notification failed:", err));
      }

      afterBillUpdate = async () => {
        if (wasApproved && changedBits.length > 0) {
          // Accounts pay from this bill, so tell them it moved under them.
          const { data: accountsUsers } = await supabase
            .from("users")
            .select("id")
            .eq("role", "accounts")
            .eq("is_active", true);
          if (accountsUsers && accountsUsers.length > 0) {
            await supabase.from("notifications").insert(
              accountsUsers
                .filter((u: { id: string }) => u.id !== dbUser.id)
                .map((u: { id: string }) => ({
                  user_id: u.id,
                  type: "bill_corrected",
                  title: resetsApproval ? "Approved bill raised — back for approval" : "Approved bill corrected",
                  body: `${bill.bill_number}: ${summary}${changeReason ? ` — ${changeReason}` : ""}`,
                  url: `/accounting/vendor-payments/${id}`,
                  entity_type: "vendor_bill",
                  entity_id: id,
                }))
            );
          }
        }
        if (changedBits.length > 0) {
          await replyOnOpenBillQueries({
            billId: id,
            author: { id: dbUser.id, role: dbUser.role, full_name: dbUser.full_name },
            message: `Corrected ${bill.bill_number}: ${summary}.${changeReason ? ` Reason: ${changeReason.replace(/[.\s]+$/, "")}.` : ""}${resetsApproval && wasApproved ? " The amount went up, so it is back with the approver." : ""}`,
          });
        }
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

  if (afterBillUpdate) {
    await (afterBillUpdate as () => Promise<void>)();
    if (extraPoChange) {
      extraAuditChanges.po_status = extraPoChange as { old: unknown; new: unknown };
    }
  }

  // Keep the Supporting Documents list in sync with a file replaced via
  // edit_invoice_details — otherwise the "invoice" document row still points
  // at the old file while vendor_bills.invoice_file_url has already moved on.
  if (syncedInvoiceFileUrl) {
    const fileName = syncedInvoiceFileUrl.split("/").pop() || "invoice";
    const { data: existingInvoiceDoc } = await supabase
      .from("vendor_bill_documents")
      .select("id")
      .eq("bill_id", id)
      .eq("doc_type", "invoice")
      .maybeSingle();

    const syncResult = existingInvoiceDoc
      ? await supabase
          .from("vendor_bill_documents")
          .update({ file_url: syncedInvoiceFileUrl, file_name: fileName })
          .eq("id", existingInvoiceDoc.id)
      : await supabase
          .from("vendor_bill_documents")
          .insert({ bill_id: id, file_url: syncedInvoiceFileUrl, file_name: fileName, doc_type: "invoice", uploaded_by: dbUser.id });

    if (syncResult.error) {
      console.error(`[bills/${id}] failed to sync invoice document after edit_invoice_details:`, syncResult.error.message);
    }
  }

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: ["unapprove", "withdraw", "unsign_cheque"].includes(parsed.data.action) ? "rollback" : "update",
    performedBy: dbUser.id,
    changes: {
      ...diffChanges(bill as Record<string, unknown>, { ...bill, ...updatePayload } as Record<string, unknown>),
      ...extraAuditChanges,
    },
  });

  return NextResponse.json({ data: updated });
}

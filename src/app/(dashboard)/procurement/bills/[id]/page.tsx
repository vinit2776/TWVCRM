"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { emitApprovalChanged } from "@/lib/approval-events";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft, Loader2, Truck, FileText, Calendar, CreditCard, Package, ExternalLink,
  CheckCircle2, XCircle, Clock, Send, Activity, CheckCircle,
  ClipboardList, ChevronDown, ChevronUp, FilePlus, AlertTriangle, RefreshCcw,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  BILL_PAYMENT_MODE_LABELS,
  BILL_APPROVAL_STATUS_LABELS, BILL_APPROVAL_STATUS_COLORS,
  AUTO_APPROVED_BADGE_CLASS,
  REJECTION_OUTCOME_LABELS, PO_ADVANCE_PAYMENT_MODE_LABELS,
  PROCUREMENT_DEPARTMENT_LABELS,
  PAYMENT_BATCH_TYPE_LABELS,
  PARTIAL_APPROVAL_REASONS, PARTIAL_APPROVAL_REASON_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { summarizeAuditEvent, AUDIT_TONE_DOT, AUDIT_TONE_TEXT } from "@/lib/audit-labels";
import { computeBatchDate, formatBatchDate } from "@/lib/payment-batch";
import { poValidity, PO_VALIDITY_CLASS, staleBannerFor } from "@/lib/approval-display";
import { VendorEmailBanner } from "@/components/finance-intelligence/vendor-email-banner";
import { ElectricityBillBreakupCard } from "@/components/procurement/electricity-bill-breakup-card";
import type { VendorBill, PaymentBatchType } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { QueryButton } from "@/components/queries/query-button";

// ── Types ─────────────────────────────────────────────────────────────────────

type ChainData = {
  bill: {
    id: string; bill_number: string; invoice_number: string | null;
    invoice_date: string; due_date: string | null; total_amount: number;
    amount_paid: number; payment_status: string; approval_status: string;
    payment_mode: string | null; payment_reference: string | null; payment_date: string | null;
    notes: string | null; invoice_file_url: string | null; invoice_signed_url: string | null;
    approved_at: string | null;
    approved_amount: number | null;
    approved_amount_note: string | null;
    gst_amount: number | null;
    creator: { id: string; full_name: string } | null;
    approver: { id: string; full_name: string } | null;
    vendor_id: string; po_id: string | null;
    vendor_bill_payments?: Array<{
      id: string; amount: number; payment_mode: string;
      payment_reference: string | null; payment_date: string;
      notes: string | null;
      recorder: { id: string; full_name: string } | null;
    }>;
  };
  vendor: {
    id: string; name: string; category: string; contact_name?: string;
    contact_phone?: string; contact_email?: string; gstin?: string; pan_number?: string;
    is_approved: boolean;
  } | null;
  po: {
    id: string; po_number: string; status: string; po_type: string;
    created_at: string; total_ordered_amount: number | null;
    expected_delivery_date: string | null;
    orderer: { id: string; full_name: string } | null;
    purchase_order_items?: Array<{ id: string; item_name: string; quantity_ordered: number; unit: string; unit_price: number | null }>;
  } | null;
  mr: {
    id: string; pr_number: string; department: string;
    total_estimated_amount: number | null; created_at: string;
    approved_at: string | null; approval_code: string | null;
    requester: { id: string; full_name: string } | null;
    approver: { id: string; full_name: string } | null;
  } | null;
  deliveryChallans: Array<{
    id: string; dc_number: string | null; dc_date: string | null;
    file_url: string | null; signed_url: string | null; notes: string | null;
    received_at: string;
    receiver: { id: string; full_name: string } | null;
  }>;
  serviceReports: Array<{
    id: string; cycle_number: number; period_from: string; period_to: string;
    report_file_url: string | null; signed_url: string | null;
    created_at: string;
    recorder: { id: string; full_name: string } | null;
  }>;
  kycDocs: Array<{ label: string; field: string; path: string; signedUrl: string | null }>;
  auditTrail: Array<{
    id: string; entity_type: string; entity_id: string; action: string;
    changes: Record<string, { old: unknown; new: unknown }> | null;
    created_at: string;
    performer: { id: string; full_name: string } | null;
  }>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUDIT_ACTION_LABELS: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  approved: "Approved",
  rejected: "Rejected",
  deleted: "Deleted",
  status_changed: "Status Changed",
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  vendor_bill: "Invoice",
  purchase_order: "Purchase Order",
  purchase_request: "Material Request",
};

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  payment_status: "Payment",
  approval_status: "Approval",
  amount_paid: "Amount Paid",
};

function AuditEntry({
  row, billId, poId, mrId,
}: {
  row: ChainData["auditTrail"][number];
  billId: string;
  poId: string | null;
  mrId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const changes = row.changes ?? {};
  const hasChanges = Object.keys(changes).length > 0;
  const entityLabel = ENTITY_TYPE_LABELS[row.entity_type] ?? row.entity_type;

  // Same human-label pipeline as the Acc Payables audit timeline.
  const summary = summarizeAuditEvent(row);
  const dotColor = AUDIT_TONE_DOT[summary.tone];
  const headingColor = AUDIT_TONE_TEXT[summary.tone];
  let sourceHint: string | null = null;
  if (row.entity_id === poId) sourceHint = "from PO";
  else if (row.entity_id === mrId) sourceHint = "from MR";

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${dotColor}`} />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="pb-4 flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <span className={`text-sm font-medium ${headingColor}`}>{summary.label}</span>
            <span className="text-xs text-muted-foreground ml-2 bg-muted px-1.5 py-0.5 rounded">{entityLabel}</span>
            {sourceHint && (
              <span className="text-[10px] text-muted-foreground ml-1.5 italic">{sourceHint}</span>
            )}
          </div>
          <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
            {new Date(row.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {row.performer?.full_name ?? "System"}
          {summary.detail && (
            <>
              {" · "}
              <span className={`font-medium ${headingColor}`}>{summary.detail}</span>
            </>
          )}
        </p>
        {hasChanges && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-xs text-primary flex items-center gap-1 hover:underline"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? "Hide" : "Show"} changes
          </button>
        )}
        {expanded && hasChanges && (
          <div className="mt-2 space-y-1">
            {Object.entries(changes).map(([field, { old: oldVal, new: newVal }]) => (
              <div key={field} className="text-xs bg-muted/50 rounded px-2 py-1">
                <span className="font-medium text-muted-foreground">{FIELD_LABELS[field] ?? field}:</span>{" "}
                {oldVal != null ? <span className="line-through text-red-600">{String(oldVal)}</span> : <span className="text-muted-foreground italic">—</span>}
                {" → "}
                <span className="text-green-700 font-medium">{newVal != null ? String(newVal) : "—"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function VendorBillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useCurrentUser();
  const currentUserRole = user?.role ?? null;

  const [bill, setBill] = useState<VendorBill | null>(null);
  const [chain, setChain] = useState<ChainData | null>(null);
  const [loading, setLoading] = useState(true);

  // Approval
  const [approveLoading, setApproveLoading] = useState(false);
  const [approveDialog, setApproveDialog] = useState(false);
  const [approveType, setApproveType] = useState<"full" | "partial">("full");
  const [approveAmount, setApproveAmount] = useState("");
  const [approveNote, setApproveNote] = useState("");
  const [approveReason, setApproveReason] = useState("");
  const [batchType, setBatchType] = useState<PaymentBatchType | "">("");
  const [approveGstAmount, setApproveGstAmount] = useState<string>("");
  // Soft-nudge dialog state — appears once when approver clicks Approve with GST blank.
  const [approveBlankGstConfirm, setApproveBlankGstConfirm] = useState(false);
  // Set to true after approver confirms the "Accounts will set GST later" nudge,
  // so the next click on Approve goes through without re-prompting.
  const [approveBlankGstAck, setApproveBlankGstAck] = useState(false);

  // Rejection dialog
  const [rejectDialog, setRejectDialog] = useState(false);
  const [rejectLoading, setRejectLoading] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  // Edit-amount-and-resubmit dialog (rejected bills only)
  const [resubmitDialog, setResubmitDialog] = useState(false);
  const [resubmitAmount, setResubmitAmount] = useState<string>("");
  const [resubmitLoading, setResubmitLoading] = useState(false);

  // Resend confirmation dialog
  const [resendDialog, setResendDialog] = useState(false);
  const [resendCc, setResendCc] = useState("");
  const [resendLoading, setResendLoading] = useState(false);

  // GST update
  const [gstDialog, setGstDialog] = useState(false);
  const [gstAmountInput, setGstAmountInput] = useState<string>("");
  const [gstZeroConfirm, setGstZeroConfirm] = useState(false);
  const [gstLoading, setGstLoading] = useState(false);

  // Fix Due Date (shown when approver hits due_date_in_past error)
  const [showFixDueDate, setShowFixDueDate] = useState(false);
  const [fixDueDateValue, setFixDueDateValue] = useState("");
  const [fixDueDateLoading, setFixDueDateLoading] = useState(false);

  const today = new Date().toISOString().split("T")[0];


  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [billRes, chainRes] = await Promise.all([
      fetch(`/api/procurement/bills/${id}`),
      fetch(`/api/procurement/bills/${id}/chain`),
    ]);
    if (billRes.ok) {
      const json = await billRes.json();
      setBill(json.data);
    } else {
      toast.error("Failed to load bill");
      router.push("/procurement/bills");
    }
    if (chainRes.ok) {
      const json = await chainRes.json();
      setChain(json.data);
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleResendConfirmation = async () => {
    setResendLoading(true);
    try {
      const ccList = resendCc.split(",").map((e) => e.trim()).filter(Boolean);
      const res = await fetch(`/api/procurement/bills/${id}/payment-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cc: ccList }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to send email");
      } else {
        toast.success("Payment confirmation sent to vendor");
        setResendDialog(false);
        setResendCc("");
      }
    } finally {
      setResendLoading(false);
    }
  };

  const handleApprove = async (forceAckBlankGst = false) => {
    if (!bill) return;
    if (!batchType) {
      toast.error("Select a payment batch schedule before approving");
      return;
    }
    // GST amount is OPTIONAL at approval — Accounts will set it before recording payment.
    // Approvers cannot use "0" as a filler — that path lives on the Accounts side where
    // the actual invoice is on hand. So at approval: either enter a real positive amount, or leave blank.
    const gstProvided = approveGstAmount !== "" && parseFloat(approveGstAmount) > 0;
    const gstVal = gstProvided ? parseFloat(approveGstAmount) : null;
    if (gstVal !== null) {
      const maxGstVal = Math.round(Number(bill.total_amount) * 0.28 * 100) / 100;
      if (gstVal > maxGstVal) {
        toast.error(`GST amount cannot exceed 28% of the invoice base (max ${formatCurrency(maxGstVal)})`);
        return;
      }
    }
    // Soft nudge: if GST is blank, ask the approver to confirm Accounts will set it later.
    if (gstVal === null && !approveBlankGstAck && !forceAckBlankGst) {
      setApproveBlankGstConfirm(true);
      return;
    }
    setApproveLoading(true);
    const body: Record<string, unknown> = {
      action: "approve",
      batch_type: batchType,
      ...(gstVal !== null ? { gst_amount: gstVal } : {}),
    };
    if (approveType === "partial") {
      const amt = parseFloat(approveAmount);
      if (!approveAmount || isNaN(amt) || amt <= 0) {
        toast.error("Enter a valid partial amount");
        setApproveLoading(false);
        return;
      }
      if (!approveReason) {
        toast.error("Select a reason for the partial approval");
        setApproveLoading(false);
        return;
      }
      if (!approveNote.trim()) {
        toast.error("Add a short note explaining the partial approval");
        setApproveLoading(false);
        return;
      }
      body.approved_amount = amt;
      body.approved_amount_note = approveNote.trim();
      body.approved_amount_reason = approveReason;
    }
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "due_date_in_past") {
          // Show inline "Fix Due Date" dialog so approver can correct without rejecting
          setFixDueDateValue(today);
          setShowFixDueDate(true);
          return;
        }
        toast.error(json.error || "Failed to approve invoice");
        return;
      }
      toast.success(approveType === "partial" ? "Invoice partially approved" : "Invoice approved");
      setApproveDialog(false);
      setBatchType("");
      setApproveGstAmount("");
      setApproveBlankGstAck(false);
      setApproveReason("");
      setApproveAmount("");
      setApproveNote("");
      emitApprovalChanged();
      await fetchAll();
    } finally {
      setApproveLoading(false);
    }
  };

  const handleFixDueDate = async () => {
    if (!fixDueDateValue || fixDueDateValue < today) {
      toast.error("Please select today or a future date");
      return;
    }
    setFixDueDateLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_due_date", due_date: fixDueDateValue }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to update due date"); return; }
      toast.success(`Due date updated to ${fixDueDateValue} — retrying approval…`);
      setShowFixDueDate(false);
      await fetchAll();
      // Reopen approve dialog so approver can confirm
      setApproveDialog(true);
    } finally {
      setFixDueDateLoading(false);
    }
  };

  const handleApproveBalance = async () => {
    setApproveLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_balance" }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed"); return; }
      toast.success("Full balance approved for payment");
      emitApprovalChanged();
      await fetchAll();
    } finally {
      setApproveLoading(false);
    }
  };

  const handleReject = async () => {
    if (!rejectionReason.trim()) {
      toast.error("Rejection reason is required");
      return;
    }

    setRejectLoading(true);
    let navigated = false;
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          rejection_reason: rejectionReason.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to reject invoice");
        return;
      }
      toast.success(json.message || "Invoice rejected");
      setRejectDialog(false);
      emitApprovalChanged();
      if (json.data === null) {
        navigated = true;
        router.push("/procurement/bills");
      } else {
        await fetchAll();
      }
    } finally {
      if (!navigated) setRejectLoading(false);
    }
  };


  const handleUpdateGst = async () => {
    if (!bill) return;
    const gstVal = gstAmountInput === "" ? 0 : parseFloat(gstAmountInput);
    if (isNaN(gstVal) || gstVal < 0) { toast.error("Enter a valid GST amount"); return; }
    const maxGstVal = Math.round(Number(bill.total_amount) * 0.28 * 100) / 100;
    if (gstVal > maxGstVal) {
      toast.error(`GST amount cannot exceed 28% of the invoice base (max ${formatCurrency(maxGstVal)})`);
      return;
    }
    if (gstVal === 0 && !gstZeroConfirm) {
      toast.error("Please tick the confirmation checkbox to set GST to zero");
      return;
    }
    setGstLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_gst", gst_amount: gstVal, gst_zero_confirmed: gstVal === 0 ? true : undefined }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to update GST"); return; }
      toast.success("GST rate updated");
      setGstDialog(false);
      setGstZeroConfirm(false);
      await fetchAll();
    } finally {
      setGstLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!bill) return null;

  const vendor = bill.procurement_vendors as { id: string; name: string; contact_name?: string; contact_phone?: string } | null;
  const billGst   = Number(bill.gst_amount ?? 0);
  const remaining = Number(bill.total_amount) + billGst - Number(bill.amount_paid);
  const canApprove = ["admin", "manager"].includes(currentUserRole ?? "");

  const linkedPo = bill.purchase_orders as {
    id: string; po_number: string; status: string; po_type?: string;
    advance_status?: string; advance_amount?: number | null;
    advance_payment_mode?: string | null; advance_payment_reference?: string | null;
    advance_payment_date?: string | null;
  } | null;
  const hasAdvanceCredit = linkedPo?.advance_status === "processed" && (linkedPo?.advance_amount ?? 0) > 0;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  const isGoods = !chain?.po || chain.po.po_type !== "service";

  const confirmationSent = chain?.auditTrail?.some((e) => {
    const changes = e.changes ?? {};
    return Object.keys(changes).some((k) => k.includes("payment_confirmation_email"));
  }) ?? false;

  const BILL_LIFECYCLE_STAGES = [
    "MR Raised",
    "MR Approved",
    "PO Created",
    isGoods ? "Goods Received" : "Service Completed",
    "Invoice Received",
    "Invoice Approved",
    "Payment Recorded",
    "Fully Settled",
    "Confirmation Sent",
  ];

  type StageStatus = "completed" | "current" | "stopped" | "pending";

  function getLifecycleStatuses(): StageStatus[] {
    const completions = [
      true, // Invoice exists so MR was raised (or can be without MR; show as complete)
      !!(chain?.mr?.approved_at),
      !!(chain?.po),
      isGoods ? (chain?.deliveryChallans?.length ?? 0) > 0 : (chain?.serviceReports?.length ?? 0) > 0,
      true, // We're on the bill page
      bill!.approval_status === "approved" || bill!.approval_status === "rejected",
      bill!.payment_status !== "unpaid",
      bill!.payment_status === "paid",
      confirmationSent,
    ];

    const statuses: StageStatus[] = [];
    let foundCurrent = false;

    for (let i = 0; i < BILL_LIFECYCLE_STAGES.length; i++) {
      if (i === 5 && bill!.approval_status === "rejected") {
        statuses.push("stopped");
        foundCurrent = true;
        continue;
      }
      if (foundCurrent) {
        statuses.push("pending");
        continue;
      }
      if (completions[i]) {
        statuses.push("completed");
      } else {
        statuses.push("current");
        foundCurrent = true;
      }
    }

    return statuses;
  }

  const lifecycleStatuses = getLifecycleStatuses();
  const nextStageIndex = lifecycleStatuses.findIndex((s) => s === "current");
  const nextStageName = nextStageIndex >= 0 ? BILL_LIFECYCLE_STAGES[nextStageIndex] : null;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageBreadcrumb
        current={{ label: bill.bill_number }}
        fallbackParent={{ href: "/procurement/bills", label: "Vendor Bills" }}
      />
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/bills")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono">{bill.bill_number}</h1>
              <Badge variant="secondary" className={BILL_PAYMENT_STATUS_COLORS[bill.payment_status]}>
                {BILL_PAYMENT_STATUS_LABELS[bill.payment_status]}
              </Badge>
              <Badge variant="secondary" className={BILL_APPROVAL_STATUS_COLORS[bill.approval_status]}>
                {BILL_APPROVAL_STATUS_LABELS[bill.approval_status]}
              </Badge>
              {bill.auto_approved && (
                <Badge variant="secondary" className={AUTO_APPROVED_BADGE_CLASS}>
                  Auto-approved
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {vendor?.name ?? "Unknown vendor"}
            </p>
            <div className="mt-2">
              <QueryButton entityType="vendor_bill" entityId={bill.id} />
            </div>
            {bill.auto_approved && bill.auto_approval_note && (
              <p className="text-xs text-muted-foreground mt-1">{bill.auto_approval_note}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {bill.approval_status === "pending" && canApprove && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setRejectionReason("");
                  setRejectDialog(true);
                }}
                className="text-red-600 border-red-200 hover:bg-red-50"
                disabled={approveLoading || rejectLoading}
              >
                <XCircle className="h-4 w-4 mr-1" /> Reject
              </Button>
              <Button
                onClick={() => {
                  setApproveType("full");
                  setApproveAmount("");
                  setApproveNote("");
                  setApproveBlankGstAck(false);
                  setApproveDialog(true);
                }}
                className="bg-green-600 hover:bg-green-700"
                disabled={approveLoading || rejectLoading}
              >
                {approveLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
              </Button>
            </>
          )}
          {bill.approval_status === "approved" &&
            bill.approved_amount !== null &&
            Number(bill.approved_amount) < Number(bill.total_amount) &&
            canApprove && (
            <Button
              size="sm"
              variant="outline"
              className="text-amber-700 border-amber-300 hover:bg-amber-50"
              onClick={handleApproveBalance}
              disabled={approveLoading}
            >
              {approveLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Approve Balance
            </Button>
          )}
          {bill.approval_status === "rejected" && bill.rejection_outcome === "replacement" && bill.po_id && (
            <Button
              onClick={() => router.push(`/procurement/bills/new?po_id=${bill.po_id}&replaces=${bill.id}`)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              <FilePlus className="h-4 w-4 mr-1" /> Re-upload Replacement Invoice
            </Button>
          )}
        </div>
      </div>

      {/* Pending approval banner */}
      {bill.approval_status === "pending" && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 flex items-center gap-3">
          <Clock className="h-5 w-5 text-yellow-600 flex-shrink-0" />
          <p className="text-sm text-yellow-800">
            This invoice is awaiting approval from a manager or admin before payment can be recorded.
          </p>
        </div>
      )}

      {/* Vendor-email nag (touch point D — page-level banner) */}
      {chain?.vendor?.id && !chain.vendor.contact_email && (
        <VendorEmailBanner
          vendorId={chain.vendor.id}
          vendorName={chain.vendor.name}
          onEmailSaved={() => fetchAll()}
        />
      )}

      {/* Partial-approval banner — visible at the top of the bill so anyone
          opening it (including the Accounts team) immediately understands the
          ceiling, the reason, and who approved it. */}
      {bill.approval_status === "approved" &&
        bill.approved_amount !== null &&
        bill.approved_amount !== undefined &&
        Number(bill.approved_amount) < Number(bill.total_amount) - 0.01 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-700 flex-shrink-0" />
            <p className="text-sm font-semibold text-amber-900">
              Partially approved: {formatCurrency(Number(bill.approved_amount))} of {formatCurrency(Number(bill.total_amount))}
              {" "}— balance held: {formatCurrency(Number(bill.total_amount) - Number(bill.approved_amount))}
            </p>
          </div>
          <p className="text-xs text-amber-800 pl-6">
            <strong>Reason:</strong>{" "}
            {bill.approved_amount_reason
              ? (PARTIAL_APPROVAL_REASON_LABELS[bill.approved_amount_reason] ?? bill.approved_amount_reason)
              : <span className="italic">not recorded (approved before this field existed)</span>}
            {bill.approver?.full_name ? ` · approved by ${bill.approver.full_name}` : ""}
          </p>
          {bill.approved_amount_note && (
            <p className="text-xs text-amber-700 pl-6 italic">&ldquo;{bill.approved_amount_note}&rdquo;</p>
          )}
        </div>
      )}

      {/* Stale-PO banner — warns approvers that the underlying PO is old */}
      {(() => {
        if (bill.approval_status !== "pending") return null;
        const msg = staleBannerFor(chain?.po?.expected_delivery_date);
        if (!msg) return null;
        return (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-900">{msg}</p>
          </div>
        );
      })()}

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bill Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Truck className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Vendor: </span>
                <span className="font-medium">{vendor?.name ?? "—"}</span>
              </span>
            </div>
            {vendor?.contact_name && (
              <div className="flex items-center gap-2.5 pl-[26px]">
                <span className="text-xs text-muted-foreground">
                  {vendor.contact_name}
                  {vendor.contact_phone ? ` · ${vendor.contact_phone}` : ""}
                </span>
              </div>
            )}
            {bill.purchase_orders && (
              <div className="flex items-center gap-2.5">
                <Package className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Purchase Order: </span>
                  <Link
                    href={`/procurement/orders/${bill.purchase_orders.id}`}
                    className="text-primary hover:underline font-mono"
                  >
                    {bill.purchase_orders.po_number}
                  </Link>
                </span>
              </div>
            )}
            {bill.invoice_number && (
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Invoice #: </span>
                  {bill.invoice_number}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2.5">
              <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Invoice Date: </span>
                {formatDate(bill.invoice_date)}
              </span>
            </div>
            {bill.due_date && (
              <div className="flex items-center gap-2.5">
                <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Due Date: </span>
                  <span className={bill.due_date < today && bill.payment_status !== "paid" ? "text-amber-700 font-medium" : ""}>
                    {formatDate(bill.due_date)}
                    {bill.due_date < today && bill.payment_status !== "paid" && " (Overdue)"}
                  </span>
                </span>
              </div>
            )}
            {bill.invoice_file_url && (
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Invoice File: </span>
                  <a
                    href={bill.invoice_file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    View Invoice <ExternalLink className="h-3 w-3" />
                  </a>
                </span>
              </div>
            )}
            {bill.notes && (
              <div className="flex items-start gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Notes: </span>
                  {bill.notes}
                </span>
              </div>
            )}

            {/* Approval info */}
            {bill.approval_status === "approved" && bill.approved_at && (
              <div className="flex items-center gap-2.5 border-t pt-3">
                <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Approved: </span>
                  {formatDate(bill.approved_at)}
                  {bill.approver?.full_name ? ` by ${bill.approver.full_name}` : ""}
                </span>
              </div>
            )}
            {bill.approval_status === "rejected" && (
              <div className="border-t pt-3 space-y-2">
                <div className="flex items-start gap-2.5">
                  <XCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <span className="text-muted-foreground">Rejected: </span>
                    {bill.rejection_reason}
                    {bill.approved_at && (
                      <span className="text-muted-foreground"> · {formatDate(bill.approved_at)}</span>
                    )}
                    {bill.approver?.full_name && (
                      <span className="text-muted-foreground"> by {bill.approver.full_name}</span>
                    )}
                  </div>
                </div>
                {bill.rejection_outcome && (
                  <div className="flex items-center gap-2.5 pl-[26px]">
                    <span className="text-xs text-muted-foreground">
                      Outcome: {REJECTION_OUTCOME_LABELS[bill.rejection_outcome] ?? bill.rejection_outcome}
                    </span>
                  </div>
                )}
                {/* Resubmit affordance — typical use case: original amount was GST-inclusive. */}
                <div className="pl-[26px] pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setResubmitAmount(String(bill.total_amount ?? ""));
                      setResubmitDialog(true);
                    }}
                  >
                    <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                    Edit amount & resubmit
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Payment Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Invoice Amount</span>
              <span className="text-xl font-bold">{formatCurrency(bill.total_amount)}</span>
            </div>

            {/* GST Breakdown — total_amount is base (pre-GST), gst_amount is additive */}
            {(() => {
              const gstAmt = Number(bill.gst_amount ?? 0);
              const baseAmt = Number(bill.total_amount); // total_amount IS the base
              return (
                <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 space-y-1">
                  <div className="flex justify-between text-xs text-blue-700">
                    <span>Base (pre-GST)</span>
                    <span className="font-medium">{formatCurrency(baseAmt)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-blue-700">
                    <span>GST</span>
                    <span className="font-medium">{gstAmt > 0 ? `+ ${formatCurrency(gstAmt)}` : "—"}</span>
                  </div>
                  <div className="flex justify-between text-xs text-blue-900 font-semibold border-t border-blue-200 pt-1">
                    <span>Total Payable</span>
                    <span>{formatCurrency(baseAmt + gstAmt)}</span>
                  </div>
                  {canApprove && bill.payment_status !== "paid" && (
                    <button
                      type="button"
                      onClick={() => { setGstAmountInput(gstAmt > 0 ? String(gstAmt) : ""); setGstZeroConfirm(false); setGstDialog(true); }}
                      className="text-[10px] text-blue-500 hover:text-blue-700 underline mt-0.5"
                    >
                      {gstAmt > 0 ? "Change GST amount" : "Set GST amount"}
                    </button>
                  )}
                </div>
              );
            })()}

            {bill.approved_amount !== null && Number(bill.approved_amount) < Number(bill.total_amount) && (
              <div className="flex justify-between text-sm">
                <span className="text-amber-700 font-medium">Approved for Payment</span>
                <span className="font-medium text-amber-700">{formatCurrency(Number(bill.approved_amount))}</span>
              </div>
            )}
            {hasAdvanceCredit && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground text-orange-700">
                  Advance Paid
                  {linkedPo?.advance_payment_mode && (
                    <span className="ml-1 text-xs">
                      ({PO_ADVANCE_PAYMENT_MODE_LABELS[linkedPo.advance_payment_mode] ?? linkedPo.advance_payment_mode}
                      {linkedPo.advance_payment_reference ? ` · ${linkedPo.advance_payment_reference}` : ""})
                    </span>
                  )}
                </span>
                <span className="font-medium text-orange-700">
                  − {formatCurrency(Math.min(linkedPo!.advance_amount!, bill.total_amount))}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Amount Paid</span>
              <span className="font-medium text-green-700">{formatCurrency(bill.amount_paid)}</span>
            </div>
            {bill.approved_amount !== null && Number(bill.approved_amount) < Number(bill.total_amount) && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-teal-700 font-medium">Balance Approved</span>
                  <span className="font-medium text-teal-700">
                    {formatCurrency(Math.max(0, Number(bill.approved_amount) + billGst - Number(bill.amount_paid)))}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-amber-700 font-medium">Pending Payment Approval</span>
                  <span className="font-medium text-amber-700">
                    {formatCurrency(Number(bill.total_amount) - Number(bill.approved_amount))}
                  </span>
                </div>
              </>
            )}
            <div className="flex justify-between text-sm border-t pt-2">
              <span className="font-medium">Balance Due</span>
              <span className={`font-bold ${remaining > 0 ? "text-red-600" : "text-green-600"}`}>
                {formatCurrency(remaining > 0 ? remaining : 0)}
              </span>
            </div>
            {bill.payment_mode && (
              <>
                <div className="border-t pt-2 space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Payment Mode</span>
                    <span>{BILL_PAYMENT_MODE_LABELS[bill.payment_mode as keyof typeof BILL_PAYMENT_MODE_LABELS] ?? bill.payment_mode}</span>
                  </div>
                  {bill.payment_reference && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Reference</span>
                      <span className="font-mono text-xs">{bill.payment_reference}</span>
                    </div>
                  )}
                  {bill.payment_date && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Payment Date</span>
                      <span>{formatDate(bill.payment_date)}</span>
                    </div>
                  )}
                </div>
              </>
            )}
            {bill.approved_amount_note && (
              <p className="text-xs text-amber-600 italic border-t pt-2">
                Approval note: {bill.approved_amount_note}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {bill.electricity_bill && <ElectricityBillBreakupCard bill={bill.electricity_bill} />}

      {/* Transaction Lifecycle */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Transaction Lifecycle
            </CardTitle>
            {nextStageName && (
              <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-0 text-xs">
                Next: {nextStageName}
              </Badge>
            )}
            {!nextStageName && lifecycleStatuses.every((s) => s === "completed") && (
              <Badge variant="secondary" className="bg-green-100 text-green-800 border-0 text-xs">
                Complete
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {/* Desktop horizontal stepper */}
          <div className="hidden md:flex items-start gap-0 overflow-x-auto pb-2">
            {BILL_LIFECYCLE_STAGES.map((stage, i) => {
              const status = lifecycleStatuses[i];
              return (
                <div key={stage} className="flex items-start flex-1 min-w-0">
                  <div className="flex flex-col items-center flex-1 min-w-0">
                    <div className="relative flex items-center justify-center">
                      {status === "completed" && (
                        <div className="w-7 h-7 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                          <CheckCircle className="h-4 w-4 text-white" />
                        </div>
                      )}
                      {status === "current" && (
                        <div className="w-7 h-7 rounded-full bg-amber-400 flex items-center justify-center shrink-0 ring-4 ring-amber-100 animate-pulse">
                          <div className="w-2.5 h-2.5 rounded-full bg-white" />
                        </div>
                      )}
                      {status === "stopped" && (
                        <div className="w-7 h-7 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                          <XCircle className="h-4 w-4 text-white" />
                        </div>
                      )}
                      {status === "pending" && (
                        <div className="w-7 h-7 rounded-full border-2 border-muted-foreground/30 bg-background flex items-center justify-center shrink-0">
                          <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                        </div>
                      )}
                    </div>
                    <p className={`text-[10px] mt-1.5 text-center leading-tight px-1 ${
                      status === "completed" ? "text-green-700 font-medium" :
                      status === "current" ? "text-amber-700 font-semibold" :
                      status === "stopped" ? "text-red-600 font-medium" :
                      "text-muted-foreground"
                    }`}>
                      {stage}
                    </p>
                  </div>
                  {i < BILL_LIFECYCLE_STAGES.length - 1 && (
                    <div className={`h-px w-4 mt-3.5 shrink-0 ${
                      lifecycleStatuses[i] === "completed" ? "bg-green-400" : "bg-muted-foreground/20"
                    }`} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Mobile vertical list */}
          <div className="flex flex-col gap-2 md:hidden">
            {BILL_LIFECYCLE_STAGES.map((stage, i) => {
              const status = lifecycleStatuses[i];
              return (
                <div key={stage} className="flex items-center gap-3">
                  {status === "completed" && (
                    <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                      <CheckCircle className="h-3.5 w-3.5 text-white" />
                    </div>
                  )}
                  {status === "current" && (
                    <div className="w-6 h-6 rounded-full bg-amber-400 flex items-center justify-center shrink-0 ring-2 ring-amber-100 animate-pulse">
                      <div className="w-2 h-2 rounded-full bg-white" />
                    </div>
                  )}
                  {status === "stopped" && (
                    <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                      <XCircle className="h-3.5 w-3.5 text-white" />
                    </div>
                  )}
                  {status === "pending" && (
                    <div className="w-6 h-6 rounded-full border-2 border-muted-foreground/30 bg-background flex items-center justify-center shrink-0">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
                    </div>
                  )}
                  <span className={`text-sm ${
                    status === "completed" ? "text-green-700 font-medium" :
                    status === "current" ? "text-amber-700 font-semibold" :
                    status === "stopped" ? "text-red-600 font-medium" :
                    "text-muted-foreground"
                  }`}>
                    {stage}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Document Chain */}
      {chain && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              Document Chain
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* MR */}
            {chain.mr && (
              <div className="flex items-start gap-3 p-3 rounded-lg border bg-orange-50/50">
                <div className="p-1.5 rounded bg-orange-100 shrink-0 mt-0.5">
                  <ClipboardList className="h-3.5 w-3.5 text-orange-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-orange-800 uppercase tracking-wide">Material Request</span>
                    <Link
                      href={`/procurement/requests/${chain.mr.id}`}
                      target="_blank"
                      className="text-xs text-primary flex items-center gap-1 hover:underline"
                    >
                      {chain.mr.pr_number} <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Dept: {PROCUREMENT_DEPARTMENT_LABELS[chain.mr.department as keyof typeof PROCUREMENT_DEPARTMENT_LABELS] ?? chain.mr.department}
                    {chain.mr.requester && ` · Requested by ${chain.mr.requester.full_name}`}
                  </p>
                  {chain.mr.approved_at && (
                    <p className="text-xs text-green-700 mt-0.5">
                      ✓ Approved {formatDate(chain.mr.approved_at)}
                      {chain.mr.approver && ` by ${chain.mr.approver.full_name}`}
                      {chain.mr.approval_code && (
                        <span className="ml-2 font-mono text-[10px] bg-green-100 px-1 rounded">{chain.mr.approval_code}</span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* PO */}
            {chain.po && (
              <div className="flex items-start gap-3 p-3 rounded-lg border bg-purple-50/50">
                <div className="p-1.5 rounded bg-purple-100 shrink-0 mt-0.5">
                  <Package className="h-3.5 w-3.5 text-purple-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-purple-800 uppercase tracking-wide">Purchase Order</span>
                      {(() => {
                        const v = poValidity(chain.po.expected_delivery_date);
                        return v && bill.payment_status !== "paid" ? (
                          <Badge variant="outline" className={`text-[10px] ${PO_VALIDITY_CLASS[v.tone]}`}>
                            {v.label}
                          </Badge>
                        ) : null;
                      })()}
                    </div>
                    <Link
                      href={`/procurement/orders/${chain.po.id}`}
                      target="_blank"
                      className="text-xs text-primary flex items-center gap-1 hover:underline"
                    >
                      {chain.po.po_number} <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {chain.po.po_type === "service" ? "Service PO" : "Goods PO"}
                    {chain.po.orderer && ` · Ordered by ${chain.po.orderer.full_name}`}
                    {chain.po.total_ordered_amount != null && ` · ${formatCurrency(chain.po.total_ordered_amount)}`}
                  </p>
                  {chain.po.purchase_order_items && chain.po.purchase_order_items.length > 0 && (
                    <div className="mt-2 rounded border border-purple-200 bg-white/60 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-purple-200 text-[10px] uppercase tracking-wide text-purple-800">
                            <th className="text-left font-medium px-2 py-1.5">Item</th>
                            <th className="text-right font-medium px-2 py-1.5 whitespace-nowrap">Qty</th>
                            <th className="text-right font-medium px-2 py-1.5 whitespace-nowrap">Rate</th>
                            <th className="text-right font-medium px-2 py-1.5 whitespace-nowrap">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {chain.po.purchase_order_items.map((item) => {
                            const rate = item.unit_price == null ? null : Number(item.unit_price);
                            const qty = Number(item.quantity_ordered);
                            return (
                              <tr key={item.id} className="border-b border-purple-100 last:border-0">
                                <td className="px-2 py-1.5 text-foreground">{item.item_name}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap text-muted-foreground">
                                  {qty.toLocaleString("en-IN")} <span className="text-[10px]">{item.unit}</span>
                                </td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap text-muted-foreground">
                                  {rate == null ? "—" : formatCurrency(rate)}
                                </td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap font-medium text-foreground">
                                  {rate == null ? "—" : formatCurrency(qty * rate)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Delivery Challans (goods) */}
            {isGoods && chain.deliveryChallans.length > 0 && chain.deliveryChallans.map((dc) => (
              <div key={dc.id} className="flex items-start gap-3 p-3 rounded-lg border bg-blue-50/50">
                <div className="p-1.5 rounded bg-blue-100 shrink-0 mt-0.5">
                  <Truck className="h-3.5 w-3.5 text-blue-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-blue-800 uppercase tracking-wide">Delivery Challan</span>
                    {dc.signed_url && (
                      <a
                        href={dc.signed_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary flex items-center gap-1 hover:underline"
                      >
                        View DC <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {dc.dc_number && `DC# ${dc.dc_number} · `}
                    {dc.dc_date ? formatDate(dc.dc_date) : formatDate(dc.received_at)}
                    {dc.receiver && ` · Received by ${dc.receiver.full_name}`}
                  </p>
                  {!dc.signed_url && (
                    <p className="text-xs text-amber-600 mt-0.5">No file attached to this delivery</p>
                  )}
                </div>
              </div>
            ))}

            {/* Service Reports (services) */}
            {!isGoods && chain.serviceReports.length > 0 && chain.serviceReports.map((sr) => (
              <div key={sr.id} className="flex items-start gap-3 p-3 rounded-lg border bg-teal-50/50">
                <div className="p-1.5 rounded bg-teal-100 shrink-0 mt-0.5">
                  <FileText className="h-3.5 w-3.5 text-teal-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-teal-800 uppercase tracking-wide">
                      Service Report — Cycle {sr.cycle_number}
                    </span>
                    {sr.signed_url && (
                      <a
                        href={sr.signed_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary flex items-center gap-1 hover:underline"
                      >
                        View Report <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Period: {formatDate(sr.period_from)} – {formatDate(sr.period_to)}
                    {sr.recorder && ` · Recorded by ${sr.recorder.full_name}`}
                  </p>
                </div>
              </div>
            ))}

            {/* Invoice (current bill) */}
            <div className="flex items-start gap-3 p-3 rounded-lg border bg-green-50/50">
              <div className="p-1.5 rounded bg-green-100 shrink-0 mt-0.5">
                <FileText className="h-3.5 w-3.5 text-green-700" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-green-800 uppercase tracking-wide">Vendor Invoice</span>
                  {chain.bill.invoice_signed_url ? (
                    <a
                      href={chain.bill.invoice_signed_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary flex items-center gap-1 hover:underline"
                    >
                      View Invoice <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : bill.invoice_file_url ? (
                    <a
                      href={bill.invoice_file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary flex items-center gap-1 hover:underline"
                    >
                      View Invoice <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">No file uploaded</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {bill.invoice_number && `Invoice #${bill.invoice_number} · `}
                  Date: {formatDate(bill.invoice_date)}
                  {bill.due_date && ` · Due: ${formatDate(bill.due_date)}`}
                </p>
                {bill.approval_status === "approved" && bill.approved_at && (
                  <p className="text-xs text-green-700 mt-0.5">
                    ✓ Approved {formatDate(bill.approved_at)}
                    {bill.approver?.full_name && ` by ${bill.approver.full_name}`}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transaction History */}
      {chain && chain.auditTrail.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Transaction History
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-orange-400" />
                Material Request
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-purple-400" />
                Purchase Order
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
                Invoice / Bill
              </span>
            </p>
          </CardHeader>
          <CardContent>
            <div>
              {chain.auditTrail.map((row) => (
                <AuditEntry
                  key={row.id}
                  row={row}
                  billId={chain.bill.id}
                  poId={chain.po?.id ?? null}
                  mrId={chain.mr?.id ?? null}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payment summary card with resend option */}
      {bill.payment_status !== "unpaid" && (currentUserRole === "accounts" || currentUserRole === "admin") && (
        <Card className={bill.payment_status === "paid" ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}>
          <CardContent className="py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                <div>
                  <p className="font-medium text-sm">
                    {bill.payment_status === "paid" ? "Fully Paid" : "Partial Payment Recorded"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(bill.amount_paid)} paid via {bill.payment_mode ?? "—"}
                    {bill.payment_reference && ` · ${bill.payment_reference}`}
                    {bill.payment_date && ` · ${formatDate(bill.payment_date)}`}
                  </p>
                </div>
              </div>
              <button
                className="text-xs text-primary hover:underline shrink-0"
                onClick={() => { setResendCc(""); setResendDialog(true); }}
              >
                Resend confirmation
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payment History */}
      {chain && (chain.bill.vendor_bill_payments ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              Payment History
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="px-4 py-2.5 text-left font-medium text-xs">Date</th>
                  <th className="px-4 py-2.5 text-right font-medium text-xs">Amount</th>
                  <th className="px-4 py-2.5 text-left font-medium text-xs hidden sm:table-cell">Mode</th>
                  <th className="px-4 py-2.5 text-left font-medium text-xs hidden md:table-cell">Reference</th>
                  <th className="px-4 py-2.5 text-left font-medium text-xs hidden lg:table-cell">Recorded By</th>
                  <th className="px-4 py-2.5 text-left font-medium text-xs">Note</th>
                </tr>
              </thead>
              <tbody>
                {(chain.bill.vendor_bill_payments ?? [])
                  .sort((a, b) => new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime())
                  .map((pmt, idx) => (
                    <tr key={pmt.id} className={`border-b last:border-0 ${idx % 2 === 0 ? "" : "bg-muted/20"}`}>
                      <td className="px-4 py-2.5 text-xs">{formatDate(pmt.payment_date)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-green-700">
                        {formatCurrency(pmt.amount)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground hidden sm:table-cell capitalize">
                        {pmt.payment_mode.replace(/_/g, " ")}
                      </td>
                      <td className="px-4 py-2.5 text-xs font-mono text-muted-foreground hidden md:table-cell">
                        {pmt.payment_reference ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                        {pmt.recorder?.full_name ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground italic">
                        {pmt.notes ?? "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20">
                  <td className="px-4 py-2.5 text-xs font-medium text-muted-foreground">Total Paid</td>
                  <td className="px-4 py-2.5 text-right font-bold text-green-700">
                    {formatCurrency(Number(bill.amount_paid ?? 0))}
                  </td>
                  <td colSpan={4} className="px-4 py-2.5 text-xs text-muted-foreground">
                    {bill.approved_amount !== null && Number(bill.approved_amount) < Number(bill.total_amount)
                      ? `Balance approved: ${formatCurrency(Math.max(0, Number(bill.approved_amount) + billGst - Number(bill.amount_paid)))} · Pending approval: ${formatCurrency(Number(bill.total_amount) - Number(bill.approved_amount))}`
                      : `Outstanding: ${formatCurrency(Math.max(0, Number(bill.total_amount) + billGst - Number(bill.amount_paid)))}`
                    }
                  </td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Approve Invoice Dialog */}
      <Dialog open={approveDialog} onOpenChange={setApproveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Invoice total: <strong>{formatCurrency(Number(bill.total_amount))}</strong>
            </p>

            {/* ── GST Amount (optional at approval) ──────────────────────────── */}
            <div className="space-y-2">
              <Label htmlFor="approve-gst-amount">
                GST Amount on this Invoice (₹) <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <p className="text-xs text-muted-foreground -mt-1">
                You can leave this blank — the Accounts team will set GST before recording payment. If you do enter it now, use the figure from the vendor&apos;s invoice (enter 0 if exempt).
              </p>
              {(() => {
                const gstAmt = approveGstAmount === "" ? null : parseFloat(approveGstAmount);
                const gst = gstAmt ?? 0;
                const base = Number(bill.total_amount);
                const maxGst = Math.round(base * 0.28 * 100) / 100;
                const isOver = gstAmt !== null && !isNaN(gstAmt) && gstAmt > maxGst;
                return (
                  <>
                    <Input
                      id="approve-gst-amount"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Leave blank if you don't have the invoice in hand"
                      value={approveGstAmount}
                      onChange={(e) => { setApproveGstAmount(e.target.value); setApproveBlankGstAck(false); }}
                      className={isOver ? "border-red-500 focus-visible:ring-red-500" : ""}
                    />
                    {isOver && (
                      <p className="text-xs text-red-600 flex items-center gap-1">
                        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                        GST cannot exceed 28% of invoice base (max {formatCurrency(maxGst)})
                      </p>
                    )}
                    {/* Preview breakdown — only when amount > 0 and valid */}
                    {gstAmt !== null && !isNaN(gstAmt) && gstAmt > 0 && !isOver && (
                      <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs space-y-1">
                        <div className="flex justify-between text-blue-800">
                          <span>Base Amount (pre-GST)</span>
                          <span className="font-medium">{formatCurrency(base)}</span>
                        </div>
                        <div className="flex justify-between text-blue-800">
                          <span>GST</span>
                          <span className="font-medium">+ {formatCurrency(gst)}</span>
                        </div>
                        <div className="flex justify-between text-blue-900 font-semibold border-t border-blue-200 pt-1">
                          <span>Total Payable</span>
                          <span>{formatCurrency(base + gst)}</span>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* ── Payment Batch Schedule ───────────────────────── */}
            <div className="space-y-2">
              <Label>
                Payment Batch Schedule <span className="text-red-500">*</span>
              </Label>
              <p className="text-xs text-muted-foreground -mt-1">
                When should accounts process this payment?
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(["immediate", "15th", "25th"] as PaymentBatchType[]).map((bt) => {
                  const d = computeBatchDate(bt);
                  const dateStr = formatBatchDate(d);
                  const isSelected = batchType === bt;
                  return (
                    <button
                      key={bt}
                      type="button"
                      onClick={() => setBatchType(bt)}
                      className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                        isSelected
                          ? "border-blue-500 bg-blue-50 text-blue-900"
                          : "border-muted hover:bg-muted/50"
                      }`}
                    >
                      <p className="text-sm font-semibold">{PAYMENT_BATCH_TYPE_LABELS[bt]}</p>
                      <p className={`text-xs mt-0.5 ${isSelected ? "text-blue-700" : "text-muted-foreground"}`}>
                        {dateStr}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Approval Type</Label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setApproveType("full")}
                  className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                    approveType === "full"
                      ? "border-green-500 bg-green-50 text-green-800"
                      : "border-muted hover:bg-muted/50"
                  }`}
                >
                  Approve Full Amount
                </button>
                <button
                  type="button"
                  onClick={() => setApproveType("partial")}
                  className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                    approveType === "partial"
                      ? "border-amber-500 bg-amber-50 text-amber-800"
                      : "border-muted hover:bg-muted/50"
                  }`}
                >
                  Approve Partial Amount
                </button>
              </div>
            </div>
            {approveType === "partial" && (
              <>
                <div className="space-y-1.5">
                  <Label>Approved Amount (₹) <span className="text-red-500">*</span></Label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={Number(bill.total_amount)}
                    placeholder="0.00"
                    value={approveAmount}
                    onChange={(e) => setApproveAmount(e.target.value)}
                  />
                  {approveAmount && !isNaN(parseFloat(approveAmount)) && (
                    <p className="text-xs text-amber-700">
                      Approving {formatCurrency(parseFloat(approveAmount))} of {formatCurrency(Number(bill.total_amount))}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Reason for partial approval <span className="text-red-500">*</span></Label>
                  <select
                    value={approveReason}
                    onChange={(e) => setApproveReason(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Select a reason…</option>
                    {PARTIAL_APPROVAL_REASONS.map((r) => (
                      <option key={r.code} value={r.code}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Note for Accounts <span className="text-red-500">*</span></Label>
                  <Textarea
                    placeholder="What exactly is being withheld and what unblocks the balance? (visible to Accounts)"
                    value={approveNote}
                    onChange={(e) => setApproveNote(e.target.value)}
                    rows={2}
                  />
                </div>
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  Accounts can only record payment up to the approved amount. The reason + note above will be shown to them when they record the payment, and to anyone investigating later.
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setApproveDialog(false); setApproveBlankGstAck(false); }}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => handleApprove()}
              disabled={approveLoading}
            >
              {approveLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {approveType === "partial" ? "Approve Partial" : "Approve Invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Blank-GST confirm — soft nudge when approver clicks Approve without entering GST */}
      <Dialog open={approveBlankGstConfirm} onOpenChange={setApproveBlankGstConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve without GST amount?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <p>
              You haven&apos;t entered a GST amount on this invoice.
            </p>
            <p className="text-muted-foreground">
              That&apos;s fine — the Accounts team will capture GST from the vendor&apos;s invoice
              before recording the actual payment. Payment cannot be released until GST is set.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveBlankGstConfirm(false)}>
              Go back and enter GST
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => {
                setApproveBlankGstAck(true);
                setApproveBlankGstConfirm(false);
                // Bypass the stale-closure problem: tell handleApprove explicitly to skip the gate.
                setTimeout(() => { void handleApprove(true); }, 0);
              }}
            >
              Continue — Accounts will set GST
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Invoice Dialog */}
      <Dialog open={rejectDialog} onOpenChange={setRejectDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Rejection Reason <span className="text-red-500">*</span></Label>
              <Textarea
                placeholder="Explain why this invoice is being rejected..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialog(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={rejectLoading}
            >
              {rejectLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Reject Invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resend Confirmation Dialog */}
      <Dialog open={resendDialog} onOpenChange={setResendDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Resend Payment Confirmation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {chain?.vendor?.contact_email ? (
              <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-1">
                <p className="text-muted-foreground text-xs">To</p>
                <p className="font-medium">{chain.vendor.contact_email}</p>
              </div>
            ) : chain?.vendor?.id ? (
              <VendorEmailBanner
                vendorId={chain.vendor.id}
                vendorName={chain.vendor.name}
                forceShow
                onEmailSaved={() => fetchAll()}
              />
            ) : (
              <p className="text-sm text-amber-700">No vendor linked to this bill — email cannot be added here.</p>
            )}
            <div className="space-y-1.5">
              <Label>CC (optional)</Label>
              <Input
                value={resendCc}
                onChange={(e) => setResendCc(e.target.value)}
                placeholder="e.g. accounts@company.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResendDialog(false)}>Cancel</Button>
            <Button
              onClick={handleResendConfirmation}
              disabled={resendLoading || !chain?.vendor?.contact_email}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              {resendLoading ? "Sending…" : "Resend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* GST Amount Dialog */}
      <Dialog open={gstDialog} onOpenChange={setGstDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Set GST Amount</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Enter the total GST amount as printed on the vendor&apos;s invoice. This may be a consolidated figure across multiple GST slabs.
            </p>
            {(() => {
              const gstAmt = gstAmountInput === "" ? null : parseFloat(gstAmountInput);
              const isZero = gstAmt !== null && gstAmt === 0;
              const base = Number(bill.total_amount);
              const maxGst = Math.round(base * 0.28 * 100) / 100;
              const isOver = gstAmt !== null && !isNaN(gstAmt) && gstAmt > maxGst;
              return (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="gst-amount-input">GST Amount (₹)</Label>
                    <Input
                      id="gst-amount-input"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="e.g. 1872.00"
                      value={gstAmountInput}
                      onChange={(e) => { setGstAmountInput(e.target.value); if (parseFloat(e.target.value) > 0) setGstZeroConfirm(false); }}
                      className={isOver ? "border-red-500 focus-visible:ring-red-500" : ""}
                    />
                    {isOver && (
                      <p className="text-xs text-red-600 flex items-center gap-1">
                        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                        Cannot exceed 28% of base (max {formatCurrency(maxGst)})
                      </p>
                    )}
                  </div>

                  {/* Zero-GST confirmation — shown only when amount is explicitly 0 */}
                  {isZero && (
                    <label className="flex items-start gap-2.5 cursor-pointer rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={gstZeroConfirm}
                        onChange={(e) => setGstZeroConfirm(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-amber-400 accent-amber-600 shrink-0"
                      />
                      <span className="text-xs text-amber-800 leading-relaxed">
                        I confirm this vendor&apos;s invoice has <strong>no GST</strong> (zero-rated, exempt, or unregistered vendor). Total payable = base amount only.
                      </span>
                    </label>
                  )}

                  {/* Preview breakdown — shown when amount > 0 and valid */}
                  {gstAmt !== null && !isNaN(gstAmt) && gstAmt > 0 && !isOver && (
                    <div className="rounded-md bg-blue-50 border border-blue-100 px-3 py-2 text-sm space-y-1">
                      <div className="flex justify-between text-blue-700">
                        <span>Base (pre-GST)</span><span className="font-medium">{formatCurrency(base)}</span>
                      </div>
                      <div className="flex justify-between text-blue-700">
                        <span>GST</span><span className="font-medium">+ {formatCurrency(gstAmt)}</span>
                      </div>
                      <div className="flex justify-between text-blue-900 font-semibold border-t border-blue-200 pt-1">
                        <span>Total Payable</span><span>{formatCurrency(base + gstAmt)}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setGstDialog(false); setGstZeroConfirm(false); }} disabled={gstLoading}>Cancel</Button>
            <Button
              onClick={handleUpdateGst}
              disabled={gstLoading || (gstAmountInput !== "" && parseFloat(gstAmountInput) === 0 && !gstZeroConfirm)}
            >
              {gstLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save GST Amount
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Fix Due Date dialog (opened when approve hits due_date_in_past) ─── */}
      <Dialog open={showFixDueDate} onOpenChange={setShowFixDueDate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-4 w-4" />
              Due Date Has Passed
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The payment due date on this invoice has already passed. Update it to today
            or a future date before approving.
          </p>
          <div className="space-y-2">
            <Label htmlFor="fix-due-date">New Due Date</Label>
            <Input
              id="fix-due-date"
              type="date"
              min={today}
              value={fixDueDateValue}
              onChange={(e) => setFixDueDateValue(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowFixDueDate(false)} disabled={fixDueDateLoading}>
              Cancel
            </Button>
            <Button onClick={handleFixDueDate} disabled={fixDueDateLoading || !fixDueDateValue || fixDueDateValue < today}>
              {fixDueDateLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Update &amp; Retry Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit amount & resubmit — rejected bills only. Pre-GST base only. */}
      <Dialog open={resubmitDialog} onOpenChange={setResubmitDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit amount & resubmit</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground">
              Correct the invoice amount and push this bill back into the approval queue. Enter the
              <strong> base (pre-GST) amount</strong> only — GST is captured separately later by Accounts.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="resubmit-amount">Corrected Amount (₹) <span className="text-red-500">*</span></Label>
              <Input
                id="resubmit-amount"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00 (excl. GST)"
                value={resubmitAmount}
                onChange={(e) => setResubmitAmount(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Was: {formatCurrency(Number(bill.total_amount ?? 0))}
              </p>
            </div>
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              Any previously-captured GST on this bill will be cleared — it will need to be re-entered before payment.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResubmitDialog(false)} disabled={resubmitLoading}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              disabled={resubmitLoading}
              onClick={async () => {
                const amt = parseFloat(resubmitAmount);
                if (!resubmitAmount || isNaN(amt) || amt <= 0) {
                  toast.error("Enter a valid amount greater than zero");
                  return;
                }
                setResubmitLoading(true);
                try {
                  const res = await fetch(`/api/procurement/bills/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "update_amount_and_resubmit", total_amount: amt }),
                  });
                  const json = await res.json();
                  if (!res.ok) { toast.error(json.error || "Resubmit failed"); return; }
                  toast.success("Amount updated — bill is back in the approval queue");
                  setResubmitDialog(false);
                  await fetchAll();
                } finally {
                  setResubmitLoading(false);
                }
              }}
            >
              {resubmitLoading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save & resubmit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

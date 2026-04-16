"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft, Loader2, Truck, FileText, Calendar, CreditCard, Package, ExternalLink,
  CheckCircle2, XCircle, Clock, Send, AlertCircle, Activity, CheckCircle,
  ClipboardList, ChevronDown, ChevronUp,
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  BILL_PAYMENT_MODES, BILL_PAYMENT_MODE_LABELS,
  BILL_APPROVAL_STATUS_LABELS, BILL_APPROVAL_STATUS_COLORS,
  REJECTION_OUTCOME_LABELS, PO_ADVANCE_PAYMENT_MODE_LABELS,
  PROCUREMENT_DEPARTMENT_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { VendorBill } from "@/types";

// ── Types ─────────────────────────────────────────────────────────────────────

type ChainData = {
  bill: {
    id: string; bill_number: string; invoice_number: string | null;
    invoice_date: string; due_date: string | null; total_amount: number;
    amount_paid: number; payment_status: string; approval_status: string;
    payment_mode: string | null; payment_reference: string | null; payment_date: string | null;
    notes: string | null; invoice_file_url: string | null; invoice_signed_url: string | null;
    approved_at: string | null;
    creator: { id: string; full_name: string } | null;
    approver: { id: string; full_name: string } | null;
    vendor_id: string; po_id: string | null;
  };
  vendor: {
    id: string; name: string; category: string; contact_name?: string;
    contact_phone?: string; contact_email?: string; gstin?: string; pan_number?: string;
    is_approved: boolean;
  } | null;
  po: {
    id: string; po_number: string; status: string; po_type: string;
    created_at: string; total_ordered_amount: number | null;
    orderer: { id: string; full_name: string } | null;
    purchase_order_items?: Array<{ id: string; item_name: string; quantity_ordered: number; unit: string }>;
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

  let dotColor = "bg-gray-300";
  if (row.entity_id === billId) dotColor = "bg-blue-400";
  else if (row.entity_id === poId) dotColor = "bg-purple-400";
  else if (row.entity_id === mrId) dotColor = "bg-orange-400";

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${dotColor}`} />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="pb-4 flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <span className="text-sm font-medium">{AUDIT_ACTION_LABELS[row.action] ?? row.action}</span>
            <span className="text-xs text-muted-foreground ml-2 bg-muted px-1.5 py-0.5 rounded">{entityLabel}</span>
          </div>
          <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
            {new Date(row.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {row.performer?.full_name ?? "System"}
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

  const [bill, setBill] = useState<VendorBill | null>(null);
  const [chain, setChain] = useState<ChainData | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);

  // Payment dialog
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);

  // Approval
  const [approveLoading, setApproveLoading] = useState(false);

  // Rejection dialog
  const [rejectDialog, setRejectDialog] = useState(false);
  const [rejectLoading, setRejectLoading] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejectionOutcome, setRejectionOutcome] = useState("");

  // Email dialog
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailCc, setEmailCc] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [newVendorEmail, setNewVendorEmail] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "bank_transfer">("upi");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);

  // Fetch current user role
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => setCurrentUserRole(json.role || null))
      .catch(() => setCurrentUserRole(null));
  }, []);

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

  const openPaymentDialog = () => {
    if (!bill) return;
    const remaining = Number(bill.total_amount) - Number(bill.amount_paid);
    setPaymentAmount(remaining > 0 ? String(remaining) : "");
    setPaymentMode("upi");
    setPaymentReference("");
    setPaymentDate(today);
    setPaymentDialog(true);
  };

  const handleRecordPayment = async () => {
    const amount = parseFloat(paymentAmount);
    if (!paymentAmount || isNaN(amount) || amount <= 0) {
      toast.error("Enter a valid payment amount");
      return;
    }

    setPaymentLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "record_payment",
          amount,
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || null,
          payment_date: paymentDate || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to record payment");
        return;
      }
      toast.success("Payment recorded successfully");
      setPaymentDialog(false);
      setShowEmailDialog(true);
      await fetchAll();
    } finally {
      setPaymentLoading(false);
    }
  };

  const handleApprove = async () => {
    setApproveLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to approve invoice");
        return;
      }
      toast.success("Invoice approved");
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
    const poIsGoods = bill?.purchase_orders && (bill.purchase_orders as { po_type?: string }).po_type !== "service";
    if (poIsGoods && !rejectionOutcome) {
      toast.error("Select a rejection outcome");
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
          ...(poIsGoods && { rejection_outcome: rejectionOutcome }),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to reject invoice");
        return;
      }
      toast.success(json.message || "Invoice rejected");
      setRejectDialog(false);
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

  async function handleSaveVendorEmail() {
    const email = newVendorEmail.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Enter a valid email address");
      return;
    }
    if (!chain?.vendor?.id) return;
    setSavingEmail(true);
    const res = await fetch(`/api/procurement/vendors/${chain.vendor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_email: email }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "Failed to save email");
    } else {
      toast.success("Email saved to vendor profile");
      await fetchAll();
    }
    setSavingEmail(false);
  }

  async function handleSendEmail() {
    setSendingEmail(true);
    const ccList = emailCc.split(",").map((e) => e.trim()).filter(Boolean);
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
      setShowEmailDialog(false);
      setEmailCc("");
    }
    setSendingEmail(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!bill) return null;

  const vendor = bill.procurement_vendors as { id: string; name: string; contact_name?: string; contact_phone?: string } | null;
  const remaining = Number(bill.total_amount) - Number(bill.amount_paid);
  const canApprove = ["admin", "manager"].includes(currentUserRole ?? "");
  const isGoodsPo = bill.purchase_orders && (bill.purchase_orders as { po_type?: string }).po_type !== "service";

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
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {vendor?.name ?? "Unknown vendor"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {bill.approval_status === "pending" && canApprove && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setRejectionReason("");
                  setRejectionOutcome("");
                  setRejectDialog(true);
                }}
                className="text-red-600 border-red-200 hover:bg-red-50"
                disabled={approveLoading || rejectLoading}
              >
                <XCircle className="h-4 w-4 mr-1" /> Reject
              </Button>
              <Button
                onClick={handleApprove}
                className="bg-green-600 hover:bg-green-700"
                disabled={approveLoading || rejectLoading}
              >
                {approveLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
              </Button>
            </>
          )}
          {bill.approval_status === "approved" && bill.payment_status !== "paid" && canApprove && (
            <Button
              onClick={openPaymentDialog}
              className="bg-green-600 hover:bg-green-700"
            >
              <CreditCard className="h-4 w-4 mr-1" /> Record Payment
            </Button>
          )}
          {bill.payment_status !== "unpaid" && (currentUserRole === "accounts" || currentUserRole === "admin") && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowEmailDialog(true)}
            >
              <Send className="h-4 w-4" /> Send Confirmation
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
          </CardContent>
        </Card>
      </div>

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
                    <span className="text-xs font-semibold text-purple-800 uppercase tracking-wide">Purchase Order</span>
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
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {chain.po.purchase_order_items.slice(0, 3).map((item) => item.item_name).join(", ")}
                      {chain.po.purchase_order_items.length > 3 && ` +${chain.po.purchase_order_items.length - 3} more`}
                    </p>
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

      {/* Send Confirmation card */}
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
              <Button
                variant="outline"
                size="sm"
                className="gap-2 shrink-0"
                onClick={() => setShowEmailDialog(true)}
              >
                <Send className="h-3.5 w-3.5" />
                Send Confirmation
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Record Payment Dialog */}
      <Dialog open={paymentDialog} onOpenChange={setPaymentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Balance due: <strong>{formatCurrency(remaining > 0 ? remaining : 0)}</strong>
            </p>
            <div className="space-y-1.5">
              <Label>Amount (₹) <span className="text-red-500">*</span></Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Payment Mode <span className="text-red-500">*</span></Label>
              <Select value={paymentMode} onValueChange={(v) => setPaymentMode(v as typeof paymentMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILL_PAYMENT_MODES.map((m) => (
                    <SelectItem key={m} value={m}>{BILL_PAYMENT_MODE_LABELS[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Reference / Transaction ID</Label>
              <Textarea
                placeholder="UTR number, cheque no., receipt no. (optional)"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Payment Date</Label>
              <Input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentDialog(false)}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={handleRecordPayment}
              disabled={paymentLoading}
            >
              {paymentLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Record Payment
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
            {isGoodsPo && (
              <div className="space-y-1.5">
                <Label>Outcome <span className="text-red-500">*</span></Label>
                <Select value={rejectionOutcome} onValueChange={setRejectionOutcome}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select outcome" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="return">Return Goods &amp; Cancel PO</SelectItem>
                    <SelectItem value="replacement">Request Replacement (New PR)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {!isGoodsPo && bill.purchase_orders && (
              <p className="text-sm text-muted-foreground">
                This is a service invoice. Rejecting it will void the bill, allowing a new invoice to be uploaded for this cycle.
              </p>
            )}
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

      {/* Send Payment Confirmation Email Dialog */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Payment Confirmation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Show where the email goes */}
            <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-1">
              <p className="text-muted-foreground text-xs uppercase tracking-wide font-medium">Email will be sent to</p>
              {chain?.vendor?.contact_email ? (
                <p className="font-medium">{chain.vendor.contact_email}</p>
              ) : (
                <p className="text-amber-700 text-sm flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5" /> No email registered for this vendor
                </p>
              )}
              <p className="text-muted-foreground text-xs">Subject: Payment Confirmation — {bill?.bill_number}</p>
            </div>

            {/* If email missing: show input to save it */}
            {!chain?.vendor?.contact_email && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Add vendor email address</Label>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="vendor@company.com"
                    value={newVendorEmail}
                    onChange={(e) => setNewVendorEmail(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSaveVendorEmail}
                    disabled={savingEmail}
                  >
                    {savingEmail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">This will be saved permanently to the vendor&apos;s profile</p>
              </div>
            )}

            {/* CC field */}
            <div className="space-y-1.5">
              <Label>CC (optional, comma-separated)</Label>
              <Input
                value={emailCc}
                onChange={(e) => setEmailCc(e.target.value)}
                placeholder="e.g. accounts@company.com, manager@company.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowEmailDialog(false); setEmailCc(""); }}>Cancel</Button>
            <Button
              onClick={handleSendEmail}
              disabled={sendingEmail || !chain?.vendor?.contact_email}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              {sendingEmail ? "Sending…" : "Send Confirmation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

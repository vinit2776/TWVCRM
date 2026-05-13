"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, FileText, Truck, ClipboardList, Package,
  ExternalLink, CheckCircle, AlertCircle, Clock, ChevronDown,
  ChevronUp, Send, CreditCard, Building2, ShieldCheck, Info,
  PauseCircle, PlayCircle, BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";
import { VendorEmailBanner } from "@/components/finance-intelligence/vendor-email-banner";
import { FinanceGuideCard } from "@/components/finance/finance-guide-card";

// ── Types ─────────────────────────────────────────────────────────────────────

type KycDoc = { label: string; field: string; path: string; signedUrl: string | null };

type AuditRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }>;
  created_at: string;
  performer: { id: string; full_name: string } | null;
};

type ChainData = {
  bill: {
    id: string; bill_number: string; invoice_number: string | null;
    invoice_date: string; due_date: string | null; total_amount: number;
    amount_paid: number; payment_status: string; approval_status: string;
    payment_mode: string | null; payment_reference: string | null; payment_date: string | null;
    notes: string | null; invoice_file_url: string | null; invoice_signed_url: string | null;
    approved_at: string | null; approval_code: string | null;
    approved_amount: number | null;
    approved_amount_note: string | null;
    payment_hold_status: string | null;
    payment_hold_reason: string | null;
    payment_hold_notes: string | null;
    payment_held_at: string | null;
    payment_hold_resolved_at: string | null;
    payment_hold_resolution_notes: string | null;
    holder: { id: string; full_name: string } | null;
    hold_resolver: { id: string; full_name: string } | null;
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
    bank_name?: string | null;
    bank_account_holder?: string | null;
    bank_account_number?: string | null;
    bank_ifsc?: string | null;
  } | null;
  po: {
    id: string; po_number: string; status: string; po_type: string;
    created_at: string; total_ordered_amount: number | null;
    orderer: { id: string; full_name: string } | null;
    purchase_request_items?: unknown;
    purchase_order_items?: Array<{ id: string; item_name: string; quantity_ordered: number; unit_price: number | null; unit: string }>;
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
    report_file_url: string | null; signed_url: string | null; notes: string | null;
    created_at: string;
    recorder: { id: string; full_name: string } | null;
  }>;
  kycDocs: KycDoc[];
  auditTrail: AuditRow[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: "bg-red-100 text-red-800",
  partially_paid: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-800",
};

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

function AuditEntry({ row, billId, poId, mrId }: { row: AuditRow; billId: string; poId: string | null; mrId: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const hasChanges = Object.keys(row.changes ?? {}).length > 0;
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
            {new Date(row.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
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
            {Object.entries(row.changes).map(([field, { old: oldVal, new: newVal }]) => (
              <div key={field} className="text-xs bg-muted/50 rounded px-2 py-1">
                <span className="font-medium text-muted-foreground">{field}:</span>{" "}
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

export default function VendorPaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [chain, setChain] = useState<ChainData | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);

  // Payment form
  const [payAmount, setPayAmount] = useState("");
  const [payMode, setPayMode] = useState("");
  const [payRef, setPayRef] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().split("T")[0]);
  const [payNote, setPayNote] = useState("");
  const [paying, setPaying] = useState(false);

  // Payment dialog + send confirmation toggle + resend dialog
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [sendConfirmation, setSendConfirmation] = useState(true);

  // TDS state
  type TdsSection = {
    code: string; description: string;
    rate_individual: number; rate_company: number;
    rate_min: number; rate_max: number;
  };
  const [tdsApplicable, setTdsApplicable] = useState(false);
  const [tdsEnabled, setTdsEnabled] = useState(false);
  const [tdsSections, setTdsSections] = useState<TdsSection[]>([]);
  const [tdsSectionCode, setTdsSectionCode] = useState("");
  const [tdsVendorType, setTdsVendorType] = useState<"individual" | "huf" | "company">("company");
  const [tdsRate, setTdsRate] = useState(0);
  const [tdsRateMin, setTdsRateMin] = useState(0);
  const [tdsRateMax, setTdsRateMax] = useState(20);
  const [tdsBaseAmount, setTdsBaseAmount] = useState("");
  const [tdsPanAvailable, setTdsPanAvailable] = useState(true);
  const [resendDialog, setResendDialog] = useState(false);
  const [resendCc, setResendCc] = useState("");
  const [resendLoading, setResendLoading] = useState(false);

  // PO / MR reference sheets
  const [poSheetOpen, setPoSheetOpen] = useState(false);
  const [mrSheetOpen, setMrSheetOpen] = useState(false);

  // Hold state
  const [holdDialog, setHoldDialog] = useState(false);
  const [releaseDialog, setReleaseDialog] = useState(false);
  const [holdReason, setHoldReason] = useState<string>("");
  const [holdNotes, setHoldNotes] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [holdLoading, setHoldLoading] = useState(false);

  const fetchChain = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/bills/${id}/chain`);
    if (res.ok) {
      const { data } = await res.json();
      setChain(data);
      setSendConfirmation(!!(data.vendor?.contact_email?.trim()));
      // Pre-fill payment amount with approved outstanding balance
      const approvedCeiling = Number(data.bill.approved_amount ?? data.bill.total_amount);
      const approvedOutstandingPrefill = Math.max(0, approvedCeiling - Number(data.bill.amount_paid ?? 0));
      if (approvedOutstandingPrefill > 0) setPayAmount(approvedOutstandingPrefill.toFixed(2));
    } else {
      toast.error("Failed to load bill details");
      router.push("/accounting?tab=vendor-payments");
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => {
    fetchChain();
    fetch("/api/me").then((r) => r.json()).then((d) => setUserRole(d.role ?? null));
    fetch("/api/tds/sections").then((r) => r.json()).then((d) => {
      if (d.data) setTdsSections(d.data);
    });
  }, [fetchChain]);

  async function openPaymentDialog() {
    setPaymentDialog(true);
    // Fetch TDS suggestion based on vendor + PO type
    if (chain?.vendor?.id) {
      const poType = chain.po?.po_type ?? null;
      const qs = new URLSearchParams({ vendor_id: chain.vendor.id });
      if (poType) qs.set("po_type", poType);
      const res = await fetch(`/api/tds/suggest?${qs}`);
      const json = await res.json();
      if (json.tds_applicable) {
        setTdsApplicable(true);
        setTdsEnabled(true);
        setTdsSectionCode(json.section_code ?? "");
        setTdsPanAvailable(json.pan_available ?? true);
        const rate = json.pan_available ? (json.section?.rate_company ?? 0) : 20;
        setTdsRate(rate);
        setTdsRateMin(json.pan_available ? (json.section?.rate_min ?? rate) : 20);
        setTdsRateMax(json.pan_available ? (json.section?.rate_max ?? rate) : 20);
      } else {
        setTdsApplicable(false);
        setTdsEnabled(false);
        setTdsSectionCode("");
      }
    }
  }

  const bill = chain?.bill;
  const vendor = chain?.vendor;
  const outstanding = bill ? Math.max(0, Number(bill.total_amount) - Number(bill.amount_paid ?? 0)) : 0;
  const approvedCeiling = bill ? Number(bill.approved_amount ?? bill.total_amount) : 0;
  const approvedOutstanding = bill ? Math.max(0, approvedCeiling - Number(bill.amount_paid ?? 0)) : 0;
  const isPartialApproval = bill ? (bill.approved_amount !== null && Number(bill.approved_amount) < Number(bill.total_amount)) : false;
  const balancePendingApproval = isPartialApproval && bill ? Number(bill.total_amount) - approvedCeiling : 0;
  const isFullyPaid = bill?.payment_status === "paid";
  const isOnHold = bill?.payment_hold_status === "on_hold";
  const canHoldPayment = (userRole === "accounts" || userRole === "admin" || userRole === "office_admin") && !isFullyPaid;
  const canReleaseHold = (userRole === "admin" || userRole === "manager") && isOnHold;

  const HOLD_REASON_LABELS: Record<string, string> = {
    wrong_scan: "Wrong or unclear invoice scan",
    wrong_bank_details: "Bank details incorrect",
    bank_rejected: "Payment rejected by bank",
    amount_mismatch: "Amount doesn't match approved bill",
    duplicate_suspected: "Suspected duplicate payment",
    pending_docs: "Supporting documents missing",
    other: "Other reason",
  };

  // Payment modes available by role
  const bankModes = [
    { value: "neft", label: "NEFT" },
    { value: "rtgs", label: "RTGS" },
    { value: "imps", label: "IMPS" },
    { value: "bank_transfer", label: "Bank Transfer" },
    { value: "cheque", label: "Cheque" },
  ];
  const canRecordCash = userRole === "admin" || userRole === "office_admin";
  const allPayModes = canRecordCash ? [...bankModes, { value: "cash", label: "Cash / Petty Cash" }] : bankModes;
  const canRecordPayment = userRole === "accounts" || userRole === "admin" || userRole === "office_admin";

  const tdsAmount = tdsEnabled && tdsBaseAmount && tdsRate
    ? Math.round(Number(tdsBaseAmount) * tdsRate) / 100
    : 0;
  const netToVendor = tdsEnabled && tdsAmount > 0
    ? Number(payAmount) - tdsAmount
    : Number(payAmount);

  async function handleRecordPayment() {
    if (!payMode) { toast.error("Please select a payment mode"); return; }
    if (!payAmount || Number(payAmount) <= 0) { toast.error("Enter a valid payment amount"); return; }
    if (Number(payAmount) > approvedOutstanding + 0.01) {
      toast.error(`Amount exceeds approved outstanding balance of ${formatCurrency(approvedOutstanding)}`);
      return;
    }
    if (tdsEnabled) {
      if (!tdsSectionCode) { toast.error("Select a TDS section"); return; }
      if (!tdsBaseAmount || Number(tdsBaseAmount) <= 0) { toast.error("Enter the pre-GST base amount for TDS"); return; }
      if (tdsAmount <= 0) { toast.error("TDS amount must be greater than zero"); return; }
    }
    setPaying(true);
    try {
      const tdsPayload = tdsEnabled && tdsSectionCode && tdsAmount > 0 ? {
        section_code: tdsSectionCode,
        vendor_type: tdsVendorType,
        base_amount: Number(tdsBaseAmount),
        tds_rate: tdsRate,
        tds_amount: tdsAmount,
        pan_available: tdsPanAvailable,
      } : null;

      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "record_payment",
          amount: Number(payAmount),
          payment_mode: payMode,
          payment_reference: payRef || null,
          payment_date: payDate || null,
          notes: payNote || null,
          tds: tdsPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Payment failed"); setPaying(false); return; }
      toast.success("Payment recorded successfully");
      setPaymentDialog(false);
      setPayNote("");

      if (sendConfirmation && vendor?.contact_email?.trim()) {
        const emailRes = await fetch(`/api/procurement/bills/${id}/payment-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cc: [] }),
        });
        if (emailRes.ok) {
          toast.success("Confirmation sent to vendor");
        } else {
          const emailJson = await emailRes.json();
          toast.error(emailJson.error || "Payment saved but email failed");
        }
      }

      await fetchChain();
    } catch {
      toast.error("Network error. Please try again.");
    }
    setPaying(false);
  }

  async function handleResendConfirmation() {
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
  }

  async function handleHoldPayment() {
    if (!holdReason) { toast.error("Select a hold reason"); return; }
    setHoldLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "hold_payment", hold_reason: holdReason, hold_notes: holdNotes || null }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Failed to hold payment"); return; }
      toast.success("Payment placed on hold — approvers notified");
      setHoldDialog(false);
      setHoldReason("");
      setHoldNotes("");
      await fetchChain();
    } finally {
      setHoldLoading(false);
    }
  }

  async function handleReleaseHold() {
    setHoldLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release_hold", resolution_notes: releaseNotes || null }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Failed to release hold"); return; }
      toast.success("Payment hold released — ready for payment");
      setReleaseDialog(false);
      setReleaseNotes("");
      await fetchChain();
    } finally {
      setHoldLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="animate-pulse bg-muted rounded-lg h-24" />
        ))}
      </div>
    );
  }

  if (!chain || !bill) return null;

  const mrId = chain.mr?.id ?? null;
  const poId = chain.po?.id ?? null;
  const isGoods = !chain.po || chain.po.po_type !== "service";

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl mx-auto">

      {/* First-time guide — shown only to accounts role on first visit */}
      {userRole === "accounts" && (
        <FinanceGuideCard
          guideKey="vendor-payment-detail"
          accentColor="orange"
          title="How to process this payment 👋"
          subtitle="You're on an approved vendor invoice. Here's a quick checklist before you record the payment."
          steps={[
            {
              number: 1,
              title: "Check the Document Chain",
              description: "Scroll down to see the MR → PO → Invoice chain. Click any reference to view details inline. This confirms the purchase was properly authorised.",
            },
            {
              number: 2,
              title: "Verify vendor KYC",
              description: "Check that GSTIN, PAN, and bank account details are correct. Never pay a vendor with missing bank details or KYC pending.",
            },
            {
              number: 3,
              title: "Record the payment",
              description: "Click 'Record Payment' at the top right. Enter the exact amount, mode (NEFT/RTGS/IMPS), UTR reference, and the payment date.",
            },
            {
              number: 4,
              title: "Something wrong?",
              description: "Use 'Hold Payment' if anything looks off — wrong scan, wrong bank details, amount mismatch. Admin will be notified. Don't pay in doubt.",
            },
            {
              number: 5,
              title: "TDS applies?",
              description: "The system will suggest TDS automatically. If applicable, enable it in the payment dialog and enter the pre-GST base amount. Net payable is calculated.",
            },
          ]}
          tip="After recording, a confirmation email is automatically sent to the vendor's registered email. Make sure the email is on file before saving."
        />
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 mt-0.5" onClick={() => router.push("/accounting?tab=vendor-payments")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{bill.bill_number}</h1>
            <Badge className="bg-green-100 text-green-800 border-0">Approved</Badge>
            <Badge className={`${PAYMENT_STATUS_COLORS[bill.payment_status]} border-0`}>
              {bill.payment_status === "unpaid" ? "Unpaid" : bill.payment_status === "partially_paid" ? "Partially Paid" : "Paid"}
            </Badge>
            {isOnHold && (
              <Badge className="bg-orange-100 text-orange-800 border-0 flex items-center gap-1">
                <PauseCircle className="h-3 w-3" />
                Payment On Hold
              </Badge>
            )}
            {bill.due_date && new Date(bill.due_date) < new Date() && !isFullyPaid && (
              <Badge className="bg-red-100 text-red-800 border-0">Overdue</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {vendor?.name} · Invoice {bill.invoice_number ?? "—"} · {formatDate(bill.invoice_date)}
          </p>
        </div>
        <div className="text-right shrink-0 space-y-1">
          <p className="text-2xl font-bold">{formatCurrency(Number(bill.total_amount))}</p>
          {!isFullyPaid && (
            <p className="text-sm text-amber-700 font-medium">₹{outstanding.toLocaleString("en-IN")} outstanding</p>
          )}
          {!isFullyPaid && canRecordPayment && !isOnHold && (
            <Button size="sm" onClick={openPaymentDialog} className="gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />
              Record Payment
            </Button>
          )}
          {!isFullyPaid && canHoldPayment && !isOnHold && (
            <Button size="sm" variant="outline" onClick={() => setHoldDialog(true)} className="gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50">
              <PauseCircle className="h-3.5 w-3.5" />
              Hold Payment
            </Button>
          )}
          {canReleaseHold && (
            <Button size="sm" onClick={() => setReleaseDialog(true)} className="gap-1.5 bg-green-600 hover:bg-green-700">
              <PlayCircle className="h-3.5 w-3.5" />
              Release Hold
            </Button>
          )}
        </div>
      </div>

      {/* Payment Hold Banner */}
      {isOnHold && (
        <div className="rounded-lg border-2 border-orange-300 bg-orange-50 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <PauseCircle className="h-5 w-5 text-orange-600 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-orange-900">Payment On Hold</p>
              <p className="text-sm text-orange-800 mt-0.5">
                {bill.payment_hold_reason ? HOLD_REASON_LABELS[bill.payment_hold_reason] ?? bill.payment_hold_reason : "Hold placed"}
                {bill.payment_held_at && (
                  <span className="text-orange-600 ml-1.5 text-xs">
                    · {new Date(bill.payment_held_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </p>
              {bill.payment_hold_notes && (
                <p className="text-xs text-orange-700 mt-1 italic">&ldquo;{bill.payment_hold_notes}&rdquo;</p>
              )}
            </div>
          </div>
          <div className="text-xs text-orange-700 bg-orange-100 rounded px-3 py-2 space-y-1">
            <p className="font-medium">Action required from Admin / Manager:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {bill.payment_hold_reason === "wrong_scan" && <li>Request the vendor to re-submit a clear invoice scan via procurement</li>}
              {bill.payment_hold_reason === "wrong_bank_details" && <li>Verify and update vendor bank details in the vendor profile, then release</li>}
              {bill.payment_hold_reason === "bank_rejected" && <li>Contact the bank, confirm correct account details, then release for retry</li>}
              {bill.payment_hold_reason === "amount_mismatch" && <li>Review the approved amount vs. invoice — correct via approval if needed</li>}
              {bill.payment_hold_reason === "duplicate_suspected" && <li>Cross-check payment history and bill records before releasing</li>}
              {bill.payment_hold_reason === "pending_docs" && <li>Ensure all required supporting documents are uploaded before releasing</li>}
              {(!bill.payment_hold_reason || bill.payment_hold_reason === "other") && <li>Investigate the stated issue and release once resolved</li>}
              <li>Once resolved, click <strong>Release Hold</strong> above to allow payment to proceed</li>
            </ul>
          </div>
          {canReleaseHold && (
            <Button size="sm" onClick={() => setReleaseDialog(true)} className="gap-1.5 bg-green-600 hover:bg-green-700 w-full sm:w-auto">
              <PlayCircle className="h-3.5 w-3.5" />
              Release Hold &amp; Allow Payment
            </Button>
          )}
        </div>
      )}

      {/* Document Chain */}
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
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setMrSheetOpen(true)}
                      className="text-xs text-primary flex items-center gap-1 hover:underline font-medium"
                    >
                      {chain.mr.pr_number} <BookOpen className="h-3 w-3" />
                    </button>
                    {["admin", "manager", "office_admin"].includes(userRole ?? "") && (
                      <Link href={`/procurement/requests/${chain.mr.id}`} target="_blank" className="text-xs text-muted-foreground flex items-center gap-0.5 hover:underline">
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Dept: {PROCUREMENT_DEPARTMENT_LABELS[chain.mr.department as keyof typeof PROCUREMENT_DEPARTMENT_LABELS] ?? chain.mr.department}
                  {chain.mr.requester && ` · Requested by ${chain.mr.requester.full_name}`}
                </p>
                {chain.mr.approved_at && (
                  <p className="text-xs text-green-700 mt-0.5">
                    ✓ Approved {formatDate(chain.mr.approved_at)}
                    {chain.mr.approver && ` by ${chain.mr.approver.full_name}`}
                    {chain.mr.approval_code && <span className="ml-2 font-mono text-[10px] bg-green-100 px-1 rounded">{chain.mr.approval_code}</span>}
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
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPoSheetOpen(true)}
                      className="text-xs text-primary flex items-center gap-1 hover:underline font-medium"
                    >
                      {chain.po.po_number} <BookOpen className="h-3 w-3" />
                    </button>
                    {["admin", "manager", "office_admin"].includes(userRole ?? "") && (
                      <Link href={`/procurement/orders/${chain.po.id}`} target="_blank" className="text-xs text-muted-foreground flex items-center gap-0.5 hover:underline">
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {chain.po.po_type === "service" ? "Service PO" : "Goods PO"}
                  {chain.po.orderer && ` · Ordered by ${chain.po.orderer.full_name}`}
                  {chain.po.total_ordered_amount != null && ` · ${formatCurrency(chain.po.total_ordered_amount)}`}
                </p>
                {chain.po.purchase_order_items && chain.po.purchase_order_items.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {chain.po.purchase_order_items.slice(0, 3).map((i) => i.item_name).join(", ")}
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
                    <a href={dc.signed_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary flex items-center gap-1 hover:underline">
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
                  <span className="text-xs font-semibold text-teal-800 uppercase tracking-wide">Service Report — Cycle {sr.cycle_number}</span>
                  {sr.signed_url && (
                    <a href={sr.signed_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary flex items-center gap-1 hover:underline">
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

          {/* Invoice */}
          <div className="flex items-start gap-3 p-3 rounded-lg border bg-green-50/50">
            <div className="p-1.5 rounded bg-green-100 shrink-0 mt-0.5">
              <FileText className="h-3.5 w-3.5 text-green-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-green-800 uppercase tracking-wide">Vendor Invoice</span>
                {bill.invoice_signed_url ? (
                  <a href={bill.invoice_signed_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary flex items-center gap-1 hover:underline">
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
              {bill.approved_at && (
                <p className="text-xs text-green-700 mt-0.5">
                  ✓ Approved {formatDate(bill.approved_at)}
                  {bill.approver && ` by ${bill.approver.full_name}`}
                  {bill.approval_code && <span className="ml-2 font-mono text-[10px] bg-green-100 px-1 rounded">{bill.approval_code}</span>}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Vendor KYC Quick-View */}
      {vendor && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                Vendor KYC
              </CardTitle>
              <Link href={`/procurement/vendors/${vendor.id}`} target="_blank" className="text-xs text-primary flex items-center gap-1 hover:underline">
                View full profile <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 gap-2 mb-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Vendor: </span>
                <span className="font-medium">{vendor.name}</span>
                {vendor.is_approved && <Badge className="ml-2 bg-green-100 text-green-800 text-[10px] px-1.5 border-0">KYC Verified</Badge>}
              </div>
              {vendor.gstin && (
                <div className="text-sm">
                  <span className="text-muted-foreground">GSTIN: </span>
                  <span className="font-mono">{vendor.gstin}</span>
                </div>
              )}
              {vendor.pan_number && (
                <div className="text-sm">
                  <span className="text-muted-foreground">PAN: </span>
                  <span className="font-mono">{vendor.pan_number}</span>
                </div>
              )}
              {vendor.contact_email?.trim() && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Email: </span>
                  <span>{vendor.contact_email}</span>
                </div>
              )}
            </div>

            {chain.kycDocs.length > 0 ? (
              <div className="space-y-1.5">
                {chain.kycDocs.map((doc) => (
                  <div key={doc.field} className="flex items-center justify-between text-sm py-1.5 border-b last:border-0">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />
                      <span>{doc.label}</span>
                    </div>
                    {doc.signedUrl && (
                      <a href={doc.signedUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary flex items-center gap-1 hover:underline">
                        View <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                No KYC documents uploaded for this vendor
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Audit Trail */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Transaction Audit Trail
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1 flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-orange-400" />Material Request</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-purple-400" />Purchase Order</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-blue-400" />Invoice / Bill</span>
          </p>
        </CardHeader>
        <CardContent>
          {chain.auditTrail.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No audit events recorded</p>
          ) : (
            <div>
              {chain.auditTrail.map((row) => (
                <AuditEntry key={row.id} row={row} billId={bill.id} poId={poId} mrId={mrId} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Record Payment Dialog */}
      <Dialog open={paymentDialog} onOpenChange={setPaymentDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              Record Payment
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              Outstanding: <span className="font-semibold text-amber-700">{formatCurrency(outstanding)}</span>
              {isPartialApproval && (
                <> · Approved: <span className="font-semibold text-amber-700">{formatCurrency(approvedOutstanding)}</span></>
              )}
            </p>
          </DialogHeader>

          {/* Vendor verification strip */}
          {vendor && (
            <div className="rounded-lg border bg-muted/30 divide-y text-xs">
              {/* Row 1: name + approval badge */}
              <div className="flex items-center justify-between px-3 py-2 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-semibold truncate">{vendor.name}</span>
                  {vendor.is_approved && (
                    <span className="shrink-0 bg-green-100 text-green-800 px-1.5 py-0.5 rounded text-[10px] font-medium">KYC ✓</span>
                  )}
                  {!vendor.is_approved && (
                    <span className="shrink-0 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[10px]">KYC pending</span>
                  )}
                </div>
                <span className="text-muted-foreground shrink-0 capitalize">{vendor.category?.replace(/_/g, " ")}</span>
              </div>

              {/* Row 2: GST + PAN */}
              <div className="grid grid-cols-2 px-3 py-2 gap-x-4 gap-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground w-8 shrink-0">GST</span>
                  {vendor.gstin ? (
                    <span className="font-mono">{vendor.gstin}</span>
                  ) : (
                    <span className="text-amber-600 italic">not on file</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground w-8 shrink-0">PAN</span>
                  {vendor.pan_number ? (
                    <span className="font-mono">{vendor.pan_number}</span>
                  ) : (
                    <span className="text-amber-600 italic">not on file</span>
                  )}
                </div>
                {vendor.contact_email?.trim() && (
                  <div className="flex items-center gap-1.5 col-span-2">
                    <span className="text-muted-foreground w-8 shrink-0">Email</span>
                    <span className="truncate">{vendor.contact_email.trim()}</span>
                  </div>
                )}
                {vendor.contact_phone && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground w-8 shrink-0">Phone</span>
                    <span>{vendor.contact_phone}</span>
                  </div>
                )}
                {vendor.contact_name && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground w-8 shrink-0">Contact</span>
                    <span className="truncate">{vendor.contact_name}</span>
                  </div>
                )}
              </div>

              {/* Row 3: bank details */}
              {(vendor.bank_account_number || vendor.bank_ifsc) ? (
                <div className="px-3 py-2 space-y-0.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground mb-1 font-medium">
                    <CreditCard className="h-3 w-3" />
                    Bank Details
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    {vendor.bank_name && (
                      <div className="flex items-center gap-1.5 col-span-2">
                        <span className="text-muted-foreground w-16 shrink-0">Bank</span>
                        <span className="font-medium">{vendor.bank_name}</span>
                      </div>
                    )}
                    {vendor.bank_account_holder && (
                      <div className="flex items-center gap-1.5 col-span-2">
                        <span className="text-muted-foreground w-16 shrink-0">A/c Name</span>
                        <span>{vendor.bank_account_holder}</span>
                      </div>
                    )}
                    {vendor.bank_account_number && (
                      <div className="flex items-center gap-1.5 col-span-2">
                        <span className="text-muted-foreground w-16 shrink-0">A/c No.</span>
                        <span className="font-mono tracking-wider">{vendor.bank_account_number}</span>
                      </div>
                    )}
                    {vendor.bank_ifsc && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground w-16 shrink-0">IFSC</span>
                        <span className="font-mono">{vendor.bank_ifsc}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="px-3 py-2 flex items-center gap-1.5 text-amber-700">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  <span>No bank details on file — add via vendor profile before paying</span>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4 py-1">
            {isPartialApproval && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm space-y-1">
                <p className="font-medium text-amber-800">⚠ Partial Payment Approved</p>
                <p className="text-amber-700">
                  Approved for payment: <strong>{formatCurrency(approvedCeiling)}</strong> of {formatCurrency(Number(bill.total_amount))} total.
                  Balance pending approval: <strong>{formatCurrency(balancePendingApproval)}</strong>.
                </p>
                {bill.approved_amount_note && (
                  <p className="text-amber-600 text-xs italic">Note: {bill.approved_amount_note}</p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Amount (₹) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={approvedOutstanding}
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1">
                <Label>Payment Mode *</Label>
                <Select value={payMode} onValueChange={setPayMode}>
                  <SelectTrigger><SelectValue placeholder="Select mode" /></SelectTrigger>
                  <SelectContent>
                    {allPayModes.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Reference / UTR / Cheque No.</Label>
                <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="e.g. UTR123456789" />
              </div>
              <div className="space-y-1">
                <Label>Payment Date</Label>
                <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>Note / Reason (optional)</Label>
                <Input
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="e.g. partial payment — balance on hold pending document verification"
                />
              </div>
            </div>

            {/* ── TDS Deduction ── */}
            <div className="rounded-lg border border-dashed border-blue-300 bg-blue-50/40 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-blue-900">TDS Deduction</span>
                  {!tdsApplicable && (
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
                      not suggested for this bill
                    </span>
                  )}
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tdsEnabled}
                    onChange={(e) => setTdsEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 rounded accent-blue-600"
                  />
                  <span className="text-xs text-blue-800">{tdsEnabled ? "Enabled" : "Enable"}</span>
                </label>
              </div>

              {tdsEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1 col-span-2">
                    <Label className="text-xs">TDS Section</Label>
                    <Select
                      value={tdsSectionCode}
                      onValueChange={(v) => {
                        setTdsSectionCode(v);
                        const sec = tdsSections.find((s) => s.code === v);
                        if (sec) {
                          const rate = tdsPanAvailable ? sec.rate_company : 20;
                          setTdsRate(rate);
                          setTdsRateMin(tdsPanAvailable ? sec.rate_min : 20);
                          setTdsRateMax(tdsPanAvailable ? sec.rate_max : 20);
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Select section" />
                      </SelectTrigger>
                      <SelectContent>
                        {tdsSections.map((s) => (
                          <SelectItem key={s.code} value={s.code} className="text-xs">
                            {s.code.replace("_", "(")} — {s.description}
                            {s.code.includes("_") ? ")" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Vendor Type</Label>
                    <Select
                      value={tdsVendorType}
                      onValueChange={(v) => {
                        setTdsVendorType(v as "individual" | "huf" | "company");
                        const sec = tdsSections.find((s) => s.code === tdsSectionCode);
                        if (sec && tdsPanAvailable) {
                          const rate = v === "company" ? sec.rate_company : sec.rate_individual;
                          setTdsRate(rate);
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="company">Company / LLP</SelectItem>
                        <SelectItem value="individual">Individual / Proprietor</SelectItem>
                        <SelectItem value="huf">HUF</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">
                      Rate (%)
                      {!tdsPanAvailable && (
                        <span className="ml-1 text-[10px] text-red-600">PAN missing → 20%</span>
                      )}
                    </Label>
                    <Input
                      type="number"
                      step="0.5"
                      min={tdsRateMin}
                      max={tdsRateMax}
                      value={tdsRate}
                      onChange={(e) => setTdsRate(Number(e.target.value))}
                      disabled={!tdsPanAvailable}
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Base amount (pre-GST) *</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={tdsBaseAmount}
                      onChange={(e) => setTdsBaseAmount(e.target.value)}
                      placeholder="Amount excl. GST"
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="col-span-2 rounded bg-blue-100/60 px-3 py-2 text-xs space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-blue-700">TDS deducted ({tdsRate}%):</span>
                      <span className="font-semibold text-blue-900">– {formatCurrency(tdsAmount)}</span>
                    </div>
                    <div className="flex justify-between border-t border-blue-200 pt-0.5 mt-0.5">
                      <span className="text-blue-700">Net payable to vendor:</span>
                      <span className="font-bold text-blue-900">{formatCurrency(netToVendor)}</span>
                    </div>
                    <div className="flex items-center gap-1 mt-1 text-[10px] text-blue-600">
                      <Info className="h-3 w-3 shrink-0" />
                      TDS of {formatCurrency(tdsAmount)} to be deposited to Income Tax by 7th of next month
                    </div>
                  </div>

                  {!tdsPanAvailable && (
                    <div className="col-span-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                      ⚠ PAN not on file for this vendor — rate defaulted to 20% as per Section 206AA.
                      Update vendor PAN in the vendor profile to apply the standard rate.
                    </div>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Vendor-email nag */}
            {!vendor?.contact_email?.trim() && (
              vendor?.id ? (
                <VendorEmailBanner
                  vendorId={vendor.id}
                  vendorName={vendor.name}
                  forceShow
                  onEmailSaved={() => { fetchChain(); setSendConfirmation(true); }}
                  className="mb-1"
                />
              ) : (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  No vendor linked to this bill — payment confirmation email cannot be sent.
                </p>
              )
            )}

            {/* Send confirmation toggle */}
            <label className="flex items-center gap-2.5 rounded-lg border p-3 cursor-pointer hover:bg-muted/30 transition-colors">
              <input
                type="checkbox"
                checked={sendConfirmation}
                onChange={(e) => setSendConfirmation(e.target.checked)}
                disabled={!vendor?.contact_email?.trim()}
                className="h-4 w-4 rounded border-gray-300 accent-green-600"
              />
              <div className="min-w-0">
                <span className="text-sm font-medium">Send confirmation to vendor</span>
                {vendor?.contact_email?.trim() ? (
                  <p className="text-xs text-muted-foreground">{vendor.contact_email.trim()}</p>
                ) : (
                  <p className="text-xs text-amber-600">No email on file — add above to enable</p>
                )}
              </div>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentDialog(false)} disabled={paying}>Cancel</Button>
            <Button
              onClick={() => handleRecordPayment()}
              disabled={paying || !payMode || !payAmount}
              className="gap-2"
            >
              {paying ? "Recording…" : sendConfirmation && vendor?.contact_email?.trim() ? "Record & Send" : "Record Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                    {isPartialApproval
                      ? `Balance approved: ${formatCurrency(approvedOutstanding)} · Pending approval: ${formatCurrency(balancePendingApproval)}`
                      : `Outstanding: ${formatCurrency(outstanding)}`
                    }
                  </td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Paid summary + re-send email */}
      {isFullyPaid && (
        <Card className="border-green-200 bg-green-50/30">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CheckCircle className="h-5 w-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-800">Fully Paid</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(Number(bill.total_amount))} via {bill.payment_mode ?? "—"}
                    {bill.payment_reference && ` · Ref: ${bill.payment_reference}`}
                    {bill.payment_date && ` · ${formatDate(bill.payment_date)}`}
                  </p>
                </div>
              </div>
              {(userRole === "accounts" || userRole === "admin") && (
                <button
                  className="text-xs text-primary hover:underline shrink-0"
                  onClick={() => { setResendCc(""); setResendDialog(true); }}
                >
                  Resend confirmation
                </button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Partially paid summary */}
      {bill.payment_status === "partially_paid" && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm">
          <Building2 className="h-4 w-4 text-amber-600 shrink-0" />
          <p className="text-amber-800">
            Partial payment of {formatCurrency(Number(bill.amount_paid))} recorded
            {bill.payment_reference && ` (Ref: ${bill.payment_reference})`}.
            Balance of {formatCurrency(outstanding)} remaining.
          </p>
          {(userRole === "accounts" || userRole === "admin") && (
            <button
              className="ml-auto text-xs text-primary hover:underline shrink-0"
              onClick={() => { setResendCc(""); setResendDialog(true); }}
            >
              Resend confirmation
            </button>
          )}
        </div>
      )}

      {/* Hold Payment Dialog */}
      <Dialog open={holdDialog} onOpenChange={setHoldDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PauseCircle className="h-4 w-4 text-orange-600" />
              Hold Payment
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              Admin and Manager will be notified to take action. Payment cannot be recorded while on hold.
            </p>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label>Reason for hold *</Label>
              <Select value={holdReason} onValueChange={setHoldReason}>
                <SelectTrigger>
                  <SelectValue placeholder="Select reason…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wrong_scan">Wrong or unclear invoice scan</SelectItem>
                  <SelectItem value="wrong_bank_details">Bank details incorrect</SelectItem>
                  <SelectItem value="bank_rejected">Payment rejected by bank</SelectItem>
                  <SelectItem value="amount_mismatch">Amount doesn&apos;t match approved bill</SelectItem>
                  <SelectItem value="duplicate_suspected">Suspected duplicate payment</SelectItem>
                  <SelectItem value="pending_docs">Supporting documents missing</SelectItem>
                  <SelectItem value="other">Other reason</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Additional notes (optional)</Label>
              <Input
                value={holdNotes}
                onChange={(e) => setHoldNotes(e.target.value)}
                placeholder="Describe the specific issue…"
                maxLength={500}
              />
            </div>
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
              <p className="font-medium mb-1">What happens next</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>Admin and Manager receive an in-app notification</li>
                <li>The bill will show &apos;Payment On Hold&apos; with the reason</li>
                <li>Payment cannot be recorded until the hold is released</li>
                <li>The hold and release are logged in the audit trail</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldDialog(false)} disabled={holdLoading}>Cancel</Button>
            <Button
              onClick={handleHoldPayment}
              disabled={holdLoading || !holdReason}
              className="gap-2 bg-orange-600 hover:bg-orange-700"
            >
              <PauseCircle className="h-4 w-4" />
              {holdLoading ? "Placing Hold…" : "Place Hold & Notify"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Release Hold Dialog */}
      <Dialog open={releaseDialog} onOpenChange={setReleaseDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="h-4 w-4 text-green-600" />
              Release Payment Hold
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              Confirm the issue has been resolved and payment can proceed.
            </p>
          </DialogHeader>
          <div className="space-y-4 py-1">
            {bill?.payment_hold_reason && (
              <div className="rounded-lg bg-muted p-3 text-sm space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Hold reason</p>
                <p>{HOLD_REASON_LABELS[bill.payment_hold_reason] ?? bill.payment_hold_reason}</p>
                {bill.payment_hold_notes && <p className="text-xs italic text-muted-foreground">&ldquo;{bill.payment_hold_notes}&rdquo;</p>}
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Resolution notes (optional)</Label>
              <Input
                value={releaseNotes}
                onChange={(e) => setReleaseNotes(e.target.value)}
                placeholder="e.g. Correct bank details confirmed, scan re-uploaded…"
                maxLength={500}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseDialog(false)} disabled={holdLoading}>Cancel</Button>
            <Button
              onClick={handleReleaseHold}
              disabled={holdLoading}
              className="gap-2 bg-green-600 hover:bg-green-700"
            >
              <PlayCircle className="h-4 w-4" />
              {holdLoading ? "Releasing…" : "Release Hold"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* MR Reference Sheet */}
      <Sheet open={mrSheetOpen} onOpenChange={setMrSheetOpen}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-orange-600" />
              Material Request — {chain.mr?.pr_number}
            </SheetTitle>
          </SheetHeader>
          {chain.mr && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Department</p>
                  <p className="font-medium">
                    {PROCUREMENT_DEPARTMENT_LABELS[chain.mr.department as keyof typeof PROCUREMENT_DEPARTMENT_LABELS] ?? chain.mr.department}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Requested On</p>
                  <p className="font-medium">{formatDate(chain.mr.created_at)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Requested By</p>
                  <p className="font-medium">{chain.mr.requester?.full_name ?? "—"}</p>
                </div>
                {chain.mr.total_estimated_amount != null && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Estimated Amount</p>
                    <p className="font-medium">{formatCurrency(chain.mr.total_estimated_amount)}</p>
                  </div>
                )}
              </div>
              <Separator />
              {chain.mr.approved_at ? (
                <div className="rounded-lg bg-green-50 border border-green-200 p-3 space-y-1">
                  <p className="text-xs font-semibold text-green-800 uppercase tracking-wide flex items-center gap-1.5">
                    <CheckCircle className="h-3.5 w-3.5" /> Approved
                  </p>
                  <p className="text-sm">
                    {formatDate(chain.mr.approved_at)}
                    {chain.mr.approver && ` by ${chain.mr.approver.full_name}`}
                  </p>
                  {chain.mr.approval_code && (
                    <p className="text-xs">
                      Code: <span className="font-mono bg-green-100 px-1.5 py-0.5 rounded">{chain.mr.approval_code}</span>
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                  <p className="text-xs text-amber-700">Approval pending</p>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* PO Reference Sheet */}
      <Sheet open={poSheetOpen} onOpenChange={setPoSheetOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle className="flex items-center gap-2">
              <Package className="h-4 w-4 text-purple-600" />
              Purchase Order — {chain.po?.po_number}
            </SheetTitle>
          </SheetHeader>
          {chain.po && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Type</p>
                  <p className="font-medium capitalize">{chain.po.po_type === "service" ? "Service PO" : "Goods PO"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Status</p>
                  <Badge className="capitalize">{chain.po.status.replace(/_/g, " ")}</Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Raised On</p>
                  <p className="font-medium">{formatDate(chain.po.created_at)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Raised By</p>
                  <p className="font-medium">{chain.po.orderer?.full_name ?? "—"}</p>
                </div>
                {chain.po.total_ordered_amount != null && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Total Order Value</p>
                    <p className="font-semibold text-base">{formatCurrency(chain.po.total_ordered_amount)}</p>
                  </div>
                )}
              </div>

              {chain.po.purchase_order_items && chain.po.purchase_order_items.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Line Items</p>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/40 border-b">
                            <th className="px-3 py-2 text-left font-medium">Item</th>
                            <th className="px-3 py-2 text-right font-medium">Qty</th>
                            <th className="px-3 py-2 text-right font-medium">Unit Price</th>
                            <th className="px-3 py-2 text-right font-medium">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {chain.po.purchase_order_items.map((item, idx) => (
                            <tr key={item.id} className={`border-b last:border-0 ${idx % 2 === 1 ? "bg-muted/20" : ""}`}>
                              <td className="px-3 py-2">{item.item_name}</td>
                              <td className="px-3 py-2 text-right">{item.quantity_ordered} {item.unit}</td>
                              <td className="px-3 py-2 text-right">
                                {item.unit_price != null ? formatCurrency(item.unit_price) : "—"}
                              </td>
                              <td className="px-3 py-2 text-right font-medium">
                                {item.unit_price != null ? formatCurrency(item.quantity_ordered * item.unit_price) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Resend Confirmation Dialog */}
      <Dialog open={resendDialog} onOpenChange={setResendDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Resend Payment Confirmation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {vendor?.contact_email?.trim() ? (
              <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-1">
                <p className="text-muted-foreground text-xs">To</p>
                <p className="font-medium">{vendor.contact_email.trim()}</p>
              </div>
            ) : vendor?.id ? (
              <VendorEmailBanner
                vendorId={vendor.id}
                vendorName={vendor.name}
                forceShow
                onEmailSaved={() => fetchChain()}
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
              disabled={resendLoading || !vendor?.contact_email?.trim()}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              {resendLoading ? "Sending…" : "Resend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, FileText, Truck, ClipboardList, Package,
  ExternalLink, CheckCircle, AlertCircle, Clock, ChevronDown,
  ChevronUp, Send, CreditCard, Building2, ShieldCheck,
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
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";
import { VendorEmailBanner } from "@/components/finance-intelligence/vendor-email-banner";

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

  // Send confirmation toggle (inside payment form) + resend dialog
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [resendDialog, setResendDialog] = useState(false);
  const [resendCc, setResendCc] = useState("");
  const [resendLoading, setResendLoading] = useState(false);

  const fetchChain = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/bills/${id}/chain`);
    if (res.ok) {
      const { data } = await res.json();
      setChain(data);
      setSendConfirmation(!!data.vendor?.contact_email);
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
  }, [fetchChain]);

  const bill = chain?.bill;
  const vendor = chain?.vendor;
  const outstanding = bill ? Math.max(0, Number(bill.total_amount) - Number(bill.amount_paid ?? 0)) : 0;
  const approvedCeiling = bill ? Number(bill.approved_amount ?? bill.total_amount) : 0;
  const approvedOutstanding = bill ? Math.max(0, approvedCeiling - Number(bill.amount_paid ?? 0)) : 0;
  const isPartialApproval = bill ? (bill.approved_amount !== null && Number(bill.approved_amount) < Number(bill.total_amount)) : false;
  const balancePendingApproval = isPartialApproval && bill ? Number(bill.total_amount) - approvedCeiling : 0;
  const isFullyPaid = bill?.payment_status === "paid";

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

  async function handleRecordPayment() {
    if (!payMode) { toast.error("Please select a payment mode"); return; }
    if (!payAmount || Number(payAmount) <= 0) { toast.error("Enter a valid payment amount"); return; }
    if (Number(payAmount) > approvedOutstanding + 0.01) {
      toast.error(`Amount exceeds approved outstanding balance of ${formatCurrency(approvedOutstanding)}`);
      return;
    }
    setPaying(true);
    try {
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
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Payment failed"); setPaying(false); return; }
      toast.success("Payment recorded successfully");
      setPayNote("");

      if (sendConfirmation && vendor?.contact_email) {
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
            {bill.due_date && new Date(bill.due_date) < new Date() && !isFullyPaid && (
              <Badge className="bg-red-100 text-red-800 border-0">Overdue</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {vendor?.name} · Invoice {bill.invoice_number ?? "—"} · {formatDate(bill.invoice_date)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-2xl font-bold">{formatCurrency(Number(bill.total_amount))}</p>
          {!isFullyPaid && (
            <p className="text-sm text-amber-700 font-medium">₹{outstanding.toLocaleString("en-IN")} outstanding</p>
          )}
        </div>
      </div>

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
                  <Link href={`/procurement/requests/${chain.mr.id}`} target="_blank" className="text-xs text-primary flex items-center gap-1 hover:underline" onClick={(e) => e.stopPropagation()}>
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
                  <Link href={`/procurement/orders/${chain.po.id}`} target="_blank" className="text-xs text-primary flex items-center gap-1 hover:underline">
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
              {vendor.contact_email && (
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

      {/* Record Payment */}
      {!isFullyPaid && canRecordPayment && (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              Record Payment
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Outstanding: <span className="font-semibold text-amber-700">{formatCurrency(outstanding)}</span>
              {isPartialApproval && (
                <> · Approved: <span className="font-semibold text-amber-700">{formatCurrency(approvedOutstanding)}</span></>
              )}
            </p>
          </CardHeader>
          <CardContent>
            {isPartialApproval && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm space-y-1 mb-4">
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
            <div className="grid sm:grid-cols-2 gap-4">
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
              <div className="space-y-1 sm:col-span-2">
                <Label>Note / Reason (optional)</Label>
                <Input
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="e.g. partial payment — balance on hold pending document verification"
                />
              </div>
            </div>

            <Separator className="my-4" />

            {/* Vendor-email nag — only renders if vendor has no email */}
            {vendor?.id && !vendor.contact_email && (
              <VendorEmailBanner
                vendorId={vendor.id}
                vendorName={vendor.name}
                forceShow
                onEmailSaved={() => { fetchChain(); setSendConfirmation(true); }}
              />
            )}

            {/* Send confirmation toggle */}
            <label className="flex items-center gap-2.5 rounded-lg border p-3 cursor-pointer hover:bg-muted/30 transition-colors">
              <input
                type="checkbox"
                checked={sendConfirmation}
                onChange={(e) => setSendConfirmation(e.target.checked)}
                disabled={!vendor?.contact_email}
                className="h-4 w-4 rounded border-gray-300 accent-green-600"
              />
              <div className="min-w-0">
                <span className="text-sm font-medium">Send confirmation to vendor</span>
                {vendor?.contact_email ? (
                  <p className="text-xs text-muted-foreground">{vendor.contact_email}</p>
                ) : (
                  <p className="text-xs text-amber-600">No email on file — add above to enable</p>
                )}
              </div>
            </label>

            <Button
              onClick={() => handleRecordPayment()}
              disabled={paying || !payMode || !payAmount}
              className="w-full"
            >
              {paying ? "Recording…" : sendConfirmation && vendor?.contact_email ? "Record & Send" : "Record Payment"}
            </Button>
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

      {/* Resend Confirmation Dialog */}
      <Dialog open={resendDialog} onOpenChange={setResendDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Resend Payment Confirmation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {vendor?.contact_email ? (
              <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-1">
                <p className="text-muted-foreground text-xs">To</p>
                <p className="font-medium">{vendor.contact_email}</p>
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
              disabled={resendLoading || !vendor?.contact_email}
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

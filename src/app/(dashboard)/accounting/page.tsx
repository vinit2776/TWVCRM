"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { PettyCashIssuance } from "@/components/accounting/petty-cash-issuance";
import TdsPayablePage from "./tds/page";
import {
  Calculator,
  Banknote,
  Building2,
  AlertCircle,
  ChevronDown,
  History,
  CheckCircle2,
  MailX,
  ArrowRight,
  ArrowLeft,
  Layers,
  FileText,
  Loader2,
  Home,
  PauseCircle,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { formatSmartDate, formatDate, formatCurrency, cn } from "@/lib/utils";
import { VendorEmailChip } from "@/components/finance-intelligence/vendor-email-chip";
import {
  BillSearchBar, filtersToParams, EMPTY_FILTERS, type BillFilters,
} from "@/components/procurement/bill-search-bar";
import { FinanceGuideCard, GuideReopenButton } from "@/components/finance/finance-guide-card";
import { useCurrentUser } from "@/providers/current-user-provider";
import {
  classifyExpense,
  EXPENSE_CLASS_LABELS,
  EXPENSE_CLASS_COLORS,
  PROCUREMENT_DEPARTMENT_LABELS,
  PROCUREMENT_DEPARTMENT_COLORS,
  EXPENDITURE_TYPE_LABELS,
  PROCUREMENT_DEPARTMENTS,
  PARTIAL_APPROVAL_REASON_LABELS,
} from "@/lib/constants";

type VendorBillItem = {
  id: string;
  bill_number: string;
  invoice_number: string | null;
  invoice_file_url: string | null;
  invoice_date: string;
  due_date: string | null;
  total_amount: number;
  gst_rate: number | null;
  gst_amount: number | null;
  amount_paid: number;
  payment_status: string;
  approval_status: string;
  approved_amount: number | null;
  approved_amount_note: string | null;
  approved_amount_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_code: string | null;
  approver: { id: string; full_name: string } | null;
  payment_mode: string | null;
  cheque_signed_at: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  payment_batch_type: "immediate" | "15th" | "25th" | null;
  payment_batch_date: string | null;
  vendor_id: string;
  po_id: string | null;
  procurement_vendors: { id: string; name: string; contact_email?: string | null } | null;
  purchase_orders: {
    id: string;
    po_number: string;
    purchase_requests?: { department: string; expenditure_type: string } | null;
  } | null;
  manual_department: string | null;
  manual_expenditure_type: string | null;
  vendor_bill_payments?: Array<{
    id: string;
    amount: number;
    payment_mode: string;
    payment_reference: string | null;
    payment_date: string;
    notes: string | null;
    recorder: { id: string; full_name: string } | null;
  }>;
};

type PendingAdvance = {
  id: string;
  po_number: string;
  advance_amount: number;
  advance_payment_mode: string | null;
  payment_terms: string | null;
  created_at: string;
  status: string;
  vendor_id: string;
  procurement_vendors: { id: string; name: string; contact_email?: string | null } | null;
  purchase_requests: { id: string; pr_number: string } | null;
  proforma: { file_name: string; file_path: string; amount: number; signed_url: string | null } | null;
};

type TdsSection = {
  code: string; description: string;
  rate_individual: number; rate_company: number;
  rate_min: number; rate_max: number;
};

type BatchTdsState = {
  enabled: boolean;
  sectionCode: string;
  vendorType: "individual" | "huf" | "company";
  rate: number;
  rateMin: number;
  rateMax: number;
  baseAmount: string;
  panAvailable: boolean;
};

type RentPaymentItem = {
  id: string;
  payment_month: string;
  due_date: string;
  gross_rent_amount: number;
  tds_amount: number;
  net_amount_paid: number;
  net_payable: number;
  status: string;
  on_hold_reason?: string | null;
  admin_approved_at?: string | null;
  paid_date?: string | null;
  payment_mode?: string | null;
  payment_reference?: string | null;
  primary_bank?: {
    id: string; bank_name: string; account_number: string;
    ifsc_code: string; account_holder_name: string;
  } | null;
  lease?: {
    id: string;
    lease_number?: string | null;
    approval_mode: string;
    location?: { id: string; name: string } | null;
    landlord?: {
      id: string; name: string; pan_number?: string | null;
      bank_accounts?: Array<{
        id: string; bank_name: string; account_number: string;
        ifsc_code: string; account_holder_name: string;
        is_primary: boolean; is_verified: boolean;
      }>;
    } | null;
  } | null;
};

export default function AccountingPage() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("tab") ?? "vendor-payments";
    }
    return "vendor-payments";
  });

  const [vendorBills, setVendorBills]   = useState<VendorBillItem[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(10);
  const [pendingPage, setPendingPage]   = useState(1);
  const PENDING_PAGE_SIZE = 20;

  // Vendor-email audit widget (touch point C)
  const [emailAuditCount, setEmailAuditCount] = useState<number | null>(null);
  const [emailAuditHighPriority, setEmailAuditHighPriority] = useState(0);

  // Current user role (for payment permission checks)
  const { user: currentUserCtx } = useCurrentUser();
  const currentUserRole = currentUserCtx?.role ?? null;
  const canRecordPayment = ["admin", "accounts", "office_admin"].includes(currentUserRole ?? "");
  const canRecordCash = currentUserRole === "admin" || currentUserRole === "office_admin" || currentUserRole === "accounts";
  // Rent payments tab
  const [rentView, setRentView] = useState<"pending" | "paid">("pending");
  const [rentPayments, setRentPayments] = useState<RentPaymentItem[]>([]);
  const [rentLoading, setRentLoading] = useState(false);
  const [markPaidDialog, setMarkPaidDialog] = useState<{ open: boolean; payment: RentPaymentItem | null }>({ open: false, payment: null });
  const [markPaidForm, setMarkPaidForm] = useState({ paid_date: "", payment_mode: "neft", payment_reference: "", bank_account_id: "" });
  const [markPaidSubmitting, setMarkPaidSubmitting] = useState(false);

  const fetchRentPayments = useCallback(async (view: "pending" | "paid" = "pending") => {
    setRentLoading(true);
    const res = await fetch(`/api/accounting/rent-payments?view=${view}`);
    if (res.ok) setRentPayments((await res.json()).data ?? []);
    setRentLoading(false);
  }, []);

  useEffect(() => {
    if (activeTab === "rent") fetchRentPayments(rentView);
  }, [activeTab, rentView, fetchRentPayments]);

  async function handleMarkPaid() {
    if (!markPaidDialog.payment) return;
    if (!markPaidForm.paid_date || !markPaidForm.payment_reference) {
      toast.error("Paid date and reference number are required");
      return;
    }
    setMarkPaidSubmitting(true);
    const body: Record<string, unknown> = {
      paid_date: markPaidForm.paid_date,
      payment_mode: markPaidForm.payment_mode,
      payment_reference: markPaidForm.payment_reference,
    };
    if (markPaidForm.bank_account_id) body.bank_account_id = markPaidForm.bank_account_id;
    const res = await fetch(`/api/accounting/rent-payments/${markPaidDialog.payment.id}/mark-paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setMarkPaidSubmitting(false);
    if (res.ok) {
      toast.success("Payment marked as paid");
      setMarkPaidDialog({ open: false, payment: null });
      setMarkPaidForm({ paid_date: "", payment_mode: "neft", payment_reference: "", bank_account_id: "" });
      fetchRentPayments(rentView);
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Failed to mark payment as paid");
    }
  }

  const bankPayModes = [
    { value: "neft", label: "NEFT" },
    { value: "rtgs", label: "RTGS" },
    { value: "imps", label: "IMPS" },
    { value: "bank_transfer", label: "Bank Transfer" },
    { value: "cheque", label: "Cheque" },
  ];
  const allBatchPayModes = canRecordCash
    ? [...bankPayModes, { value: "cash", label: "Cash / Petty Cash" }]
    : bankPayModes;

  // Batch payment multiselect
  const [selectedBillIds, setSelectedBillIds] = useState<Set<string>>(new Set());
  const [batchWizardOpen, setBatchWizardOpen] = useState(false);
  const [batchStep, setBatchStep] = useState(0);
  const [batchDate, setBatchDate] = useState(new Date().toISOString().split("T")[0]);
  const [batchMode, setBatchMode] = useState<string>("");
  const [batchRef, setBatchRef] = useState("");
  const [batchNotes, setBatchNotes] = useState("");
  const [batchGst, setBatchGst] = useState<Record<string, string>>({});
  const [batchTds, setBatchTds] = useState<Record<string, BatchTdsState>>({});
  const [batchTdsSections, setBatchTdsSections] = useState<TdsSection[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  // Accounting-head tagging dialog (for direct-expense bills with no PO)
  const [tagDialogBillId, setTagDialogBillId] = useState<string | null>(null);
  const [tagDept, setTagDept] = useState<string>("");
  const [tagExpType, setTagExpType] = useState<string>("");
  const [tagSubmitting, setTagSubmitting] = useState(false);

  async function handleProcessAdvance() {
    if (!processingAdvance) return;
    if (!advanceForm.payment_reference.trim()) {
      toast.error("Payment reference (UTR / cheque #) is required");
      return;
    }
    setAdvanceSubmitting(true);
    try {
      const res = await fetch(`/api/procurement/orders/${processingAdvance.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "process_advance",
          advance_payment_date: advanceForm.payment_date,
          advance_payment_mode: advanceForm.payment_mode,
          advance_payment_reference: advanceForm.payment_reference.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to release advance");
        return;
      }
      toast.success(`Advance released for ${processingAdvance.po_number}`);
      setProcessingAdvance(null);
      setAdvanceForm({
        payment_mode: "neft",
        payment_reference: "",
        payment_date: new Date().toISOString().split("T")[0],
      });
      await fetchPendingAdvances();
    } finally {
      setAdvanceSubmitting(false);
    }
  }

  async function handleTagSubmit() {
    if (!tagDialogBillId) return;
    setTagSubmitting(true);
    try {
      const res = await fetch(`/api/procurement/bills/${tagDialogBillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "tag_accounting",
          manual_department: tagDept || null,
          manual_expenditure_type: tagExpType || null,
        }),
      });
      if (res.ok) {
        toast.success("Accounting classification saved");
        setTagDialogBillId(null);
        await fetchVendorBills();
      } else {
        const j = await res.json();
        toast.error(j.error ?? "Failed to save classification");
      }
    } finally {
      setTagSubmitting(false);
    }
  }

  // Batch bucket filter (cash-flow planning strip)
  const [activeBatchFilter, setActiveBatchFilter] = useState<"immediate" | "15th" | "25th" | "unscheduled" | null>(null);

  // Bill search (replaces the old simple textbox)
  const [filters, setFilters] = useState<BillFilters>({
    ...EMPTY_FILTERS,
    approval_status: "approved",
    limit: "500",
  });

  // Ref always holds the latest filters so fetchVendorBills stays stable (empty deps).
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const fetchVendorBills = useCallback(async () => {
    const params = filtersToParams(filtersRef.current);
    const res = await fetch(`/api/procurement/bills?${params}`);
    if (res.ok) {
      const { data } = await res.json();
      setVendorBills(data ?? []);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pending PO advances (released by Finance, same queue as bills) ────────
  const [pendingAdvances, setPendingAdvances] = useState<PendingAdvance[]>([]);
  const [advancesLoading, setAdvancesLoading] = useState(false);
  const [processingAdvance, setProcessingAdvance] = useState<PendingAdvance | null>(null);
  const [advanceForm, setAdvanceForm] = useState({
    payment_mode: "neft" as "neft" | "rtgs" | "imps" | "bank_transfer" | "cheque" | "cash",
    payment_reference: "",
    payment_date: new Date().toISOString().split("T")[0],
  });
  const [advanceSubmitting, setAdvanceSubmitting] = useState(false);

  const fetchPendingAdvances = useCallback(async () => {
    setAdvancesLoading(true);
    try {
      const res = await fetch("/api/accounting/po-advances-pending");
      if (res.ok) {
        const { data } = await res.json();
        setPendingAdvances(data ?? []);
      }
    } finally {
      setAdvancesLoading(false);
    }
  }, []);

  // Fire when filter VALUES change — stringify guards against reference churn.
  const filtersKey = useMemo(() => filtersToParams(filters).toString(), [filters]);
  useEffect(() => {
    if (activeTab === "vendor-payments") {
      fetchVendorBills();
      fetchPendingAdvances();
    }
  }, [activeTab, filtersKey, fetchVendorBills, fetchPendingAdvances]);

  // Vendor-email audit count for the dashboard widget
  useEffect(() => {
    fetch("/api/finance-intelligence/vendor-email-nag/audit")
      .then((r) => r.json())
      .then((j) => {
        setEmailAuditCount(j.count ?? 0);
        setEmailAuditHighPriority(j.high_priority_count ?? 0);
      })
      .catch(() => { /* non-fatal */ });
  }, [vendorBills]);  // refresh after bill list refresh — likely things have changed

  // ── Vendor bill helpers ───────────────────────────────────────────────────
  const allPendingBills = useMemo(
    () => vendorBills.filter((b) => b.payment_status !== "paid"),
    [vendorBills]
  );

  // Batch bucket totals (for cash-flow planning strip)
  const batchBuckets = useMemo(() => {
    const outstanding = (b: VendorBillItem) =>
      Math.max(0, Number(b.approved_amount ?? b.total_amount) + Number(b.gst_amount ?? 0) - Number(b.amount_paid ?? 0));

    const todayStr = new Date().toISOString().split("T")[0];

    // A batched bill is overdue if its scheduled batch date has already passed.
    // Overdue bills escalate to Immediate regardless of their original batch type —
    // they should have been paid and must be cleared now.
    const isOverdue = (b: VendorBillItem) =>
      !!b.payment_batch_date && b.payment_batch_date < todayStr;

    const immediate   = allPendingBills.filter((b) =>
      b.payment_batch_type === "immediate" || (b.payment_batch_type && isOverdue(b))
    );
    const fifteenth   = allPendingBills.filter((b) => b.payment_batch_type === "15th" && !isOverdue(b));
    const twentyfifth = allPendingBills.filter((b) => b.payment_batch_type === "25th" && !isOverdue(b));
    const unscheduled = allPendingBills.filter((b) => !b.payment_batch_type);

    // Compute the next calendar date for a given day-of-month
    const nextDateForDay = (day: number): string => {
      const now = new Date();
      const candidate = new Date(now.getFullYear(), now.getMonth(), day);
      if (candidate < now) candidate.setMonth(candidate.getMonth() + 1);
      return candidate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
    };

    return {
      immediate:   { bills: immediate,   total: immediate.reduce((s, b) => s + outstanding(b), 0),   date: "Pay now" },
      "15th":      { bills: fifteenth,   total: fifteenth.reduce((s, b) => s + outstanding(b), 0),   date: nextDateForDay(15) },
      "25th":      { bills: twentyfifth, total: twentyfifth.reduce((s, b) => s + outstanding(b), 0), date: nextDateForDay(25) },
      unscheduled: { bills: unscheduled, total: unscheduled.reduce((s, b) => s + outstanding(b), 0), date: null },
    };
  }, [allPendingBills]);

  const pendingBills = activeBatchFilter
    ? batchBuckets[activeBatchFilter].bills
    : allPendingBills;

  const pendingTotalPages   = Math.ceil(pendingBills.length / PENDING_PAGE_SIZE);
  const visiblePendingBills = pendingBills.slice((pendingPage - 1) * PENDING_PAGE_SIZE, pendingPage * PENDING_PAGE_SIZE);
  const allPaidBills        = vendorBills.filter((b) => b.payment_status === "paid");
  const visiblePaidBills    = allPaidBills.slice(0, historyLimit);

  const today = new Date().toISOString().split("T")[0];

  // Batch multiselect derived values
  const selectedBills = useMemo(
    () => allPendingBills.filter((b) => selectedBillIds.has(b.id)),
    [allPendingBills, selectedBillIds]
  );
  const selectedTotal = useMemo(
    () => selectedBills.reduce((s, b) => {
      const gst = Number(b.gst_amount ?? 0);
      const base = Number(b.approved_amount ?? b.total_amount);
      return s + Math.max(0, base + gst - Number(b.amount_paid ?? 0));
    }, 0),
    [selectedBills]
  );

  function openBatchWizard() {
    const gstInit: Record<string, string> = {};
    const tdsInit: Record<string, BatchTdsState> = {};
    for (const b of selectedBills) {
      gstInit[b.id] = b.gst_amount ? String(b.gst_amount) : "";
      tdsInit[b.id] = { enabled: false, sectionCode: "", vendorType: "company", rate: 0, rateMin: 0, rateMax: 20, baseAmount: "", panAvailable: true };
    }
    setBatchGst(gstInit);
    setBatchTds(tdsInit);
    setBatchDate(today);
    const saved = typeof window !== "undefined" ? localStorage.getItem("batch_pay_last_mode") : "";
    setBatchMode(saved || "");
    setBatchRef("");
    setBatchNotes("");
    setBatchStep(0);
    setBatchWizardOpen(true);
    // Fetch TDS sections once (cached in state)
    if (batchTdsSections.length === 0) {
      fetch("/api/tds/sections").then((r) => r.json()).then((d) => {
        if (d.data) setBatchTdsSections(d.data);
      });
    }
  }

  async function handleBatchSubmit() {
    if (!batchMode) { toast.error("Select a payment mode"); return; }
    if (!batchDate) { toast.error("Select a payment date"); return; }
    if (!batchRef.trim()) { toast.error("Enter the payment reference / UTR"); return; }

    setBatchSubmitting(true);
    try {
      if (typeof window !== "undefined") localStorage.setItem("batch_pay_last_mode", batchMode);
      const billsPayload = selectedBills.map((b) => {
        const gst = parseFloat(batchGst[b.id] || "0") || 0;
        const base = Number(b.approved_amount ?? b.total_amount);
        const outstanding = Math.max(0, base + gst - Number(b.amount_paid ?? 0));
        const tds = batchTds[b.id];
        const tdsAmount = tds?.enabled && tds.baseAmount && tds.rate > 0
          ? Math.round(Number(tds.baseAmount) * tds.rate) / 100
          : 0;
        const tdsPayload = tds?.enabled && tds.sectionCode && tdsAmount > 0 ? {
          section_code: tds.sectionCode,
          vendor_type: tds.vendorType,
          base_amount: Number(tds.baseAmount),
          tds_rate: tds.rate,
          tds_amount: tdsAmount,
          pan_available: tds.panAvailable,
        } : undefined;
        return { bill_id: b.id, amount: Math.round(outstanding * 100) / 100, gst_amount: gst, tds: tdsPayload };
      });
      const res = await fetch("/api/accounting/batch-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_ref: crypto.randomUUID(),
          payment_date: batchDate,
          payment_mode: batchMode,
          payment_reference: batchRef.trim() || null,
          notes: batchNotes.trim() || null,
          bills: billsPayload,
        }),
      });
      const json = await res.json();
      if (!res.ok && res.status !== 207) {
        toast.error(typeof json.error === "string" ? json.error : "Batch payment failed");
        return;
      }
      if (json.failed_count > 0) {
        toast.error(`${json.failed_count} bill(s) failed: ${json.failed.map((f: { bill_number: string }) => f.bill_number).join(", ")}`);
      }
      if (json.processed_count > 0) {
        toast.success(`${json.processed_count} bill${json.processed_count > 1 ? "s" : ""} paid — ${formatCurrency(json.total_paid)}`);
      }
      setBatchWizardOpen(false);
      setSelectedBillIds(new Set());
      await fetchVendorBills();
    } finally {
      setBatchSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Calculator className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Acc Payables</h1>
        <GuideReopenButton guideKey="acc-payables" label="How it works" />
      </div>

      <FinanceGuideCard
        guideKey="acc-payables"
        accentColor="blue"
        title="Welcome to Accounts Payable 👋"
        subtitle="This is where you pay approved vendor invoices. Procurement raises the bills — your job here is to verify and release payments."
        steps={[
          {
            number: 1,
            title: "Find the bill to pay",
            description: "Approved bills from Procurement appear in the Pending tab. Click a bill number to open the full detail view.",
          },
          {
            number: 2,
            title: "Verify before paying",
            description: "Inside the bill, check the vendor bank details, GST, PAN, and the attached invoice scan. Never pay without verifying.",
          },
          {
            number: 3,
            title: "Record the payment",
            description: "Click 'Record Payment', enter the amount, mode (NEFT/RTGS etc.), UTR reference, and date. The vendor gets an email confirmation automatically.",
          },
          {
            number: 4,
            title: "Something doesn't look right?",
            description: "Use 'Hold Payment' to flag the bill. Admin or Manager will be notified to resolve it before payment can proceed.",
          },
          {
            number: 5,
            title: "TDS deduction",
            description: "If TDS applies (suggested automatically), enable it in the payment dialog, pick the section, and enter the pre-GST base amount. The net payable is calculated for you.",
          },
          {
            number: 6,
            title: "Petty cash",
            description: "For small cash expenses (not vendor bills), use the Petty Cash tab to issue or record a disbursement.",
          },
        ]}
        tip="If a vendor's email is missing, a banner will prompt you to add it before recording payment — confirmations can't be sent without it."
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="vendor-payments" onClick={() => fetchVendorBills()}>
            <Building2 className="h-3.5 w-3.5 mr-1" />
            Vendor Payments
            {vendorBills.filter((b) => b.payment_status !== "paid").length > 0 && (
              <span className="ml-1.5 bg-primary text-primary-foreground text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                {vendorBills.filter((b) => b.payment_status !== "paid").length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="petty-cash">
            <Banknote className="h-3.5 w-3.5 mr-1" />Petty Cash
          </TabsTrigger>
          <TabsTrigger value="tds">
            <FileText className="h-3.5 w-3.5 mr-1" />TDS Payable
          </TabsTrigger>
          {["admin", "accounts", "viewer"].includes(currentUserRole ?? "") && (
            <TabsTrigger value="rent" onClick={() => fetchRentPayments(rentView)}>
              <Home className="h-3.5 w-3.5 mr-1" />Rent
              {rentPayments.filter((p) => p.status === "approved").length > 0 && activeTab !== "rent" && (
                <span className="ml-1.5 bg-blue-600 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                  {rentPayments.filter((p) => p.status === "approved").length}
                </span>
              )}
            </TabsTrigger>
          )}
        </TabsList>

        {/* ── Vendor Payments ──────────────────────────────────────────── */}
        <TabsContent value="vendor-payments" className="mt-4">
          {billsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="animate-pulse bg-muted rounded-lg h-14" />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Bill search + filters + Pay Selected */}
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <BillSearchBar
                    initialFilters={filters}
                    baseFilters={{ approval_status: "approved" }}
                    onChange={(f) => { setFilters(f); setHistoryLimit(10); }}
                    showExport
                    placeholder="Search by bill #, invoice #, vendor, PO, notes…"
                  />
                </div>
                {canRecordPayment && selectedBillIds.size >= 2 && (
                  <button
                    onClick={openBatchWizard}
                    className="shrink-0 h-9 inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-3 transition-colors"
                  >
                    <Layers className="h-4 w-4" />
                    Pay {selectedBillIds.size} bills · {formatCurrency(selectedTotal)}
                  </button>
                )}
              </div>

              {/* ── Pending PO advances — queued for Finance to release ────────
                  Advances bypass the bill-approval flow but still need a UTR.
                  Surfaced here so Finance processes them in one place. */}
              {(advancesLoading || pendingAdvances.length > 0) && (
                <div className="rounded-lg border border-purple-200 bg-purple-50/40 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-purple-200 bg-purple-100/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-purple-800">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-600" />
                        PO Advances · Pending Release
                      </span>
                      {!advancesLoading && pendingAdvances.length > 0 && (
                        <span className="text-xs text-purple-700">
                          {pendingAdvances.length} · {formatCurrency(pendingAdvances.reduce((s, a) => s + Number(a.advance_amount ?? 0), 0))}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-purple-700">
                      Released here, not in Procurement
                    </span>
                  </div>
                  {advancesLoading ? (
                    <div className="p-4 text-xs text-purple-700">Loading…</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="text-[11px] uppercase tracking-wide text-purple-800 bg-purple-50">
                        <tr>
                          <th className="px-4 py-2 text-left font-medium">PO</th>
                          <th className="px-4 py-2 text-left font-medium">Vendor</th>
                          <th className="px-4 py-2 text-right font-medium">Advance</th>
                          <th className="px-4 py-2 text-left font-medium hidden md:table-cell">Proforma</th>
                          <th className="px-4 py-2 text-left font-medium hidden lg:table-cell">Terms</th>
                          <th className="px-4 py-2 text-right font-medium">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingAdvances.map((adv) => (
                          <tr key={adv.id} className="border-t border-purple-100 hover:bg-purple-50">
                            <td className="px-4 py-2.5 font-mono text-xs">
                              <Link href={`/procurement/orders/${adv.id}`} className="text-purple-800 hover:underline">
                                {adv.po_number}
                              </Link>
                              <div className="text-[10px] text-purple-600">
                                Raised {formatDate(adv.created_at)}
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              <p className="font-medium">{adv.procurement_vendors?.name ?? "—"}</p>
                              {adv.purchase_requests?.pr_number && (
                                <p className="text-[10px] text-muted-foreground font-mono">{adv.purchase_requests.pr_number}</p>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right font-semibold text-purple-800">
                              {formatCurrency(adv.advance_amount)}
                            </td>
                            <td className="px-4 py-2.5 hidden md:table-cell">
                              {adv.proforma?.signed_url ? (
                                <a
                                  href={adv.proforma.signed_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs text-purple-800 hover:underline"
                                >
                                  <FileText className="h-3.5 w-3.5" />
                                  View
                                </a>
                              ) : (
                                <span className="text-[11px] text-muted-foreground italic">No proforma attached</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 hidden lg:table-cell text-xs text-muted-foreground italic max-w-[280px] truncate">
                              {adv.payment_terms ?? "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              {canRecordPayment ? (
                                <button
                                  onClick={() => {
                                    setProcessingAdvance(adv);
                                    setAdvanceForm({
                                      payment_mode: "neft",
                                      payment_reference: "",
                                      payment_date: new Date().toISOString().split("T")[0],
                                    });
                                  }}
                                  className="inline-flex items-center gap-1 rounded-md bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium px-3 py-1.5"
                                >
                                  Release advance
                                </button>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">View only</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Cash-flow batch buckets */}
              {allPendingBills.length > 0 && (() => {
                type BucketKey = "immediate" | "15th" | "25th" | "unscheduled";
                const bucketConfig: Array<{
                  key: BucketKey;
                  label: string;
                  description: string;
                  activeClass: string;
                  inactiveClass: string;
                  dotClass: string;
                }> = [
                  {
                    key: "immediate",
                    label: "Immediate",
                    description: "Pay now",
                    activeClass: "border-orange-400 bg-orange-50 ring-2 ring-orange-300",
                    inactiveClass: "border-orange-200 bg-orange-50/40 hover:bg-orange-50 hover:border-orange-300",
                    dotClass: "bg-orange-500",
                  },
                  {
                    key: "15th",
                    label: "15th Batch",
                    description: batchBuckets["15th"].date,
                    activeClass: "border-blue-400 bg-blue-50 ring-2 ring-blue-300",
                    inactiveClass: "border-blue-200 bg-blue-50/40 hover:bg-blue-50 hover:border-blue-300",
                    dotClass: "bg-blue-500",
                  },
                  {
                    key: "25th",
                    label: "25th Batch",
                    description: batchBuckets["25th"].date,
                    activeClass: "border-violet-400 bg-violet-50 ring-2 ring-violet-300",
                    inactiveClass: "border-violet-200 bg-violet-50/40 hover:bg-violet-50 hover:border-violet-300",
                    dotClass: "bg-violet-500",
                  },
                  {
                    key: "unscheduled",
                    label: "Unscheduled",
                    description: "No batch set",
                    activeClass: "border-gray-400 bg-gray-100 ring-2 ring-gray-300",
                    inactiveClass: "border-gray-200 bg-gray-50/40 hover:bg-gray-50 hover:border-gray-300",
                    dotClass: "bg-gray-400",
                  },
                ];
                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {bucketConfig.map(({ key, label, description, activeClass, inactiveClass, dotClass }) => {
                      const bucket = batchBuckets[key];
                      const isActive = activeBatchFilter === key;
                      const isEmpty = bucket.bills.length === 0;
                      return (
                        <button
                          key={key}
                          onClick={() => {
                            setActiveBatchFilter(isActive ? null : key);
                            setPendingPage(1);
                          }}
                          className={cn(
                            "rounded-lg border p-3 text-left transition-colors",
                            isActive ? activeClass : inactiveClass,
                            isEmpty && "opacity-50"
                          )}
                        >
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span className={cn("h-2 w-2 rounded-full shrink-0", dotClass)} />
                            <span className="text-xs font-semibold text-foreground truncate">{label}</span>
                            {isActive && (
                              <span className="ml-auto text-[10px] font-medium text-muted-foreground">✕ clear</span>
                            )}
                          </div>
                          <p className="text-base font-bold text-foreground leading-tight">
                            {formatCurrency(bucket.total)}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {bucket.bills.length} bill{bucket.bills.length !== 1 ? "s" : ""}
                            {description && <span className="ml-1">· {description}</span>}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Vendor-email audit widget (touch point C — dashboard) */}
              {emailAuditCount !== null && emailAuditCount > 0 && (
                <Link
                  href="/accounting/vendor-email-audit"
                  className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 transition-colors hover:bg-amber-100 ${
                    emailAuditHighPriority > 0
                      ? "border-red-300 bg-red-50"
                      : "border-amber-300 bg-amber-50"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <MailX
                      className={`h-4 w-4 shrink-0 ${
                        emailAuditHighPriority > 0 ? "text-red-600" : "text-amber-600"
                      }`}
                    />
                    <p className="text-sm">
                      <span className="font-semibold">
                        {emailAuditCount} vendor{emailAuditCount === 1 ? "" : "s"} missing email
                      </span>
                      {emailAuditHighPriority > 0 && (
                        <span className="text-red-700 ml-1">
                          ({emailAuditHighPriority} with pending bills)
                        </span>
                      )}
                      <span className="text-muted-foreground ml-1">
                        — payment confirmations cannot be sent
                      </span>
                    </p>
                  </div>
                  <span className="text-xs font-medium inline-flex items-center gap-1 shrink-0">
                    Fix now <ArrowRight className="h-3 w-3" />
                  </span>
                </Link>
              )}

              {/* OpEx / CapEx / Unclassified summary strip */}
              {(() => {
                const pb = vendorBills.filter((b) => b.payment_status !== "paid");
                const opexTotal = pb
                  .filter((b) => classifyExpense(
                    b.manual_department ?? b.purchase_orders?.purchase_requests?.department,
                    b.manual_expenditure_type ?? b.purchase_orders?.purchase_requests?.expenditure_type
                  ) === "opex")
                  .reduce((s, b) => s + Math.max(0, Number(b.total_amount) + Number(b.gst_amount ?? 0) - Number(b.amount_paid ?? 0)), 0);
                const capexTotal = pb
                  .filter((b) => classifyExpense(
                    b.manual_department ?? b.purchase_orders?.purchase_requests?.department,
                    b.manual_expenditure_type ?? b.purchase_orders?.purchase_requests?.expenditure_type
                  ) === "capex")
                  .reduce((s, b) => s + Math.max(0, Number(b.total_amount) + Number(b.gst_amount ?? 0) - Number(b.amount_paid ?? 0)), 0);
                const unclassifiedCount = pb.filter((b) => classifyExpense(
                  b.manual_department ?? b.purchase_orders?.purchase_requests?.department,
                  b.manual_expenditure_type ?? b.purchase_orders?.purchase_requests?.expenditure_type
                ) === "unclassified").length;
                if (pb.length === 0) return null;
                return (
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-blue-50 text-blue-700 border-blue-200 font-medium">
                      OpEx pending: {formatCurrency(opexTotal)}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200 font-medium">
                      CapEx pending: {formatCurrency(capexTotal)}
                    </span>
                    {unclassifiedCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-red-50 text-red-700 border-red-200 font-medium">
                        {unclassifiedCount} unclassified — tag to post correctly
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Summary tiles */}
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg border bg-red-50/50 p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Unpaid</p>
                  <p className="text-lg font-bold text-red-700">
                    ₹{vendorBills.filter((b) => b.payment_status === "unpaid").reduce((s, b) => s + Number(b.total_amount), 0).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-muted-foreground">{vendorBills.filter((b) => b.payment_status === "unpaid").length} bills</p>
                </div>
                <div className="rounded-lg border bg-amber-50/50 p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Part Paid</p>
                  <p className="text-lg font-bold text-amber-700">
                    ₹{vendorBills.filter((b) => b.payment_status === "partially_paid").reduce((s, b) => s + Math.max(0, Number(b.total_amount) - Number(b.amount_paid)), 0).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-muted-foreground">{vendorBills.filter((b) => b.payment_status === "partially_paid").length} bills</p>
                </div>
                <div className="rounded-lg border bg-green-50/50 p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Total Paid</p>
                  <p className="text-lg font-bold text-green-700">
                    ₹{vendorBills.filter((b) => b.payment_status === "paid").reduce((s, b) => s + Number(b.total_amount), 0).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-muted-foreground">{vendorBills.filter((b) => b.payment_status === "paid").length} bills</p>
                </div>
              </div>

              {/* Pending bills */}
              {activeBatchFilter && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-1.5">
                  <span>Showing <strong>{activeBatchFilter === "unscheduled" ? "unscheduled" : `${activeBatchFilter} batch`}</strong> bills only</span>
                  <button
                    className="ml-auto text-blue-600 hover:text-blue-800 font-medium"
                    onClick={() => { setActiveBatchFilter(null); setPendingPage(1); }}
                  >
                    Show all
                  </button>
                </div>
              )}
              {pendingBills.length === 0 && !filters.q ? (
                <EmptyState
                  icon={Building2}
                  title="No pending vendor payments"
                  description="All approved invoices have been paid."
                />
              ) : pendingBills.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-2">Pending Payment</h3>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/30 border-b">
                          {canRecordPayment && (
                            <th className="px-3 py-3 w-8">
                              <input
                                type="checkbox"
                                className="rounded border-gray-300"
                                checked={visiblePendingBills.length > 0 && visiblePendingBills.every((b) => selectedBillIds.has(b.id))}
                                onChange={(e) => {
                                  setSelectedBillIds((prev) => {
                                    const next = new Set(prev);
                                    visiblePendingBills.forEach((b) => e.target.checked ? next.add(b.id) : next.delete(b.id));
                                    return next;
                                  });
                                }}
                                title="Select all visible bills"
                              />
                            </th>
                          )}
                          <th className="px-4 py-3 text-left font-medium">Bill #</th>
                          <th className="px-4 py-3 text-left font-medium">Vendor</th>
                          <th className="px-4 py-3 text-left font-medium hidden md:table-cell">PO</th>
                          <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Dept / Class</th>
                          <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Due</th>
                          <th className="px-4 py-3 text-right font-medium">Invoice</th>
                          <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Paid</th>
                          <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                          <th className="px-4 py-3 text-left font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visiblePendingBills.map((bill) => {
                          const gstAmt             = Number(bill.gst_amount ?? 0);
                          const gstRate            = Number(bill.gst_rate ?? 0);
                          const baseAmt            = Number(bill.total_amount);
                          const totalPayable       = baseAmt + gstAmt; // base + additive GST
                          const outstanding        = Math.max(0, totalPayable - Number(bill.amount_paid ?? 0));
                          const approvedCeiling    = Number(bill.approved_amount ?? baseAmt) + gstAmt;
                          const approvedOutstanding = Math.max(0, approvedCeiling - Number(bill.amount_paid ?? 0));
                          const isPartialApproval  = bill.approved_amount !== null && Number(bill.approved_amount) < baseAmt - 0.01;
                          const isOverdue          = !!(bill.due_date && bill.due_date < today);
                          const isSelected         = selectedBillIds.has(bill.id);
                          return (
                            <tr
                              key={bill.id}
                              className={cn(
                                "border-b last:border-0 hover:bg-muted/40 cursor-pointer",
                                isSelected && "bg-emerald-50/60"
                              )}
                              onClick={() => router.push(`/accounting/vendor-payments/${bill.id}`)}
                            >
                              {canRecordPayment && (
                                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    className="rounded border-gray-300"
                                    checked={isSelected}
                                    onChange={(e) => {
                                      setSelectedBillIds((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(bill.id);
                                        else next.delete(bill.id);
                                        return next;
                                      });
                                    }}
                                  />
                                </td>
                              )}
                              <td className="px-4 py-3 font-mono text-xs font-medium">
                                {bill.bill_number}
                                {bill.invoice_number && (
                                  <p className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-muted-foreground"
                                     onClick={(e) => e.stopPropagation()}>
                                    <FileText className="h-2.5 w-2.5 shrink-0" />
                                    {bill.invoice_file_url ? (
                                      <a
                                        href={bill.invoice_file_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="font-mono text-blue-600 hover:text-blue-800 hover:underline"
                                        title="View vendor invoice"
                                      >
                                        {bill.invoice_number}
                                      </a>
                                    ) : (
                                      <span className="font-mono">{bill.invoice_number}</span>
                                    )}
                                  </p>
                                )}
                                {bill.approved_at && (
                                  <p
                                    className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-emerald-700"
                                    title={bill.approval_code ? `Approval code: ${bill.approval_code}` : "Approved"}
                                  >
                                    <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
                                    <span className="truncate">
                                      {bill.approver?.full_name ?? "—"} · {formatSmartDate(bill.approved_at)}
                                    </span>
                                  </p>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="font-medium truncate max-w-[140px]">
                                    {bill.procurement_vendors?.name ?? "—"}
                                  </p>
                                  {bill.procurement_vendors?.id && !bill.procurement_vendors.contact_email?.trim() && (
                                    <VendorEmailChip vendorId={bill.procurement_vendors.id} />
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">
                                {bill.purchase_orders?.po_number ?? "—"}
                              </td>
                              <td className="px-4 py-3 hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                                {(() => {
                                  const effectiveDept = bill.manual_department ?? bill.purchase_orders?.purchase_requests?.department ?? null;
                                  const effectiveExpType = bill.manual_expenditure_type ?? bill.purchase_orders?.purchase_requests?.expenditure_type ?? null;
                                  const expClass = classifyExpense(effectiveDept, effectiveExpType);
                                  const isDirectExpense = !bill.po_id;
                                  return (
                                    <div className="flex flex-col gap-1">
                                      {effectiveDept ? (
                                        <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full w-fit border ${PROCUREMENT_DEPARTMENT_COLORS[effectiveDept as keyof typeof PROCUREMENT_DEPARTMENT_COLORS] ?? "bg-gray-100 text-gray-700 border-gray-200"}`}>
                                          {PROCUREMENT_DEPARTMENT_LABELS[effectiveDept] ?? effectiveDept}
                                        </span>
                                      ) : null}
                                      <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full w-fit border ${EXPENSE_CLASS_COLORS[expClass]}`}>
                                        {EXPENSE_CLASS_LABELS[expClass]}
                                      </span>
                                      {isDirectExpense && expClass === "unclassified" && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setTagDialogBillId(bill.id);
                                            setTagDept(bill.manual_department ?? "");
                                            setTagExpType(bill.manual_expenditure_type ?? "");
                                          }}
                                          className="text-[10px] text-blue-600 hover:text-blue-800 underline w-fit"
                                        >
                                          Tag now
                                        </button>
                                      )}
                                    </div>
                                  );
                                })()}
                              </td>
                              <td className="px-4 py-3 hidden sm:table-cell text-xs">
                                {bill.due_date ? (
                                  <span className={isOverdue ? "text-red-600 font-semibold flex items-center gap-1" : "text-muted-foreground"}>
                                    {isOverdue && <AlertCircle className="h-3 w-3" />}
                                    {new Date(bill.due_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}
                                  </span>
                                ) : bill.payment_batch_type === "immediate" ? (
                                  <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
                                    Immediate
                                  </span>
                                ) : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-4 py-3 text-right text-xs">
                                <div>
                                  <p>₹{baseAmt.toLocaleString("en-IN", { minimumFractionDigits: 0 })}</p>
                                  {gstRate > 0 && (
                                    <p className="text-[10px] text-blue-600 font-normal">+₹{gstAmt.toLocaleString("en-IN", { minimumFractionDigits: 0 })} GST</p>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-right text-xs hidden sm:table-cell text-green-700 font-medium">
                                {Number(bill.amount_paid ?? 0) > 0 ? `₹${Number(bill.amount_paid).toLocaleString("en-IN", { minimumFractionDigits: 0 })}` : "—"}
                              </td>
                              <td className="px-4 py-3 text-right font-semibold text-sm">
                                <div>
                                  <p className={isOverdue ? "text-red-700" : ""}>
                                    ₹{outstanding.toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                                  </p>
                                  {isPartialApproval && (
                                    <p className="text-[10px] text-amber-600 font-normal">
                                      ₹{approvedOutstanding.toLocaleString("en-IN")} approved
                                    </p>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex flex-col gap-0.5">
                                  {bill.payment_status === "partially_paid" && (
                                    <span className="text-[10px] font-medium bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full w-fit">Part Paid</span>
                                  )}
                                  {bill.payment_status === "unpaid" && (
                                    <span className="text-[10px] font-medium bg-red-100 text-red-800 px-1.5 py-0.5 rounded-full w-fit">Unpaid</span>
                                  )}
                                  {isPartialApproval && (
                                    <span
                                      className="text-[10px] font-medium bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded-full w-fit cursor-help"
                                      title={
                                        [
                                          bill.approved_amount_reason
                                            ? (PARTIAL_APPROVAL_REASON_LABELS[bill.approved_amount_reason] ?? bill.approved_amount_reason)
                                            : "Reason not recorded",
                                          bill.approved_amount_note ?? "",
                                          bill.approver?.full_name ? `Approved by ${bill.approver.full_name}` : "",
                                        ].filter(Boolean).join(" — ")
                                      }
                                    >
                                      Part Approved
                                    </span>
                                  )}
                                  {isOverdue && (
                                    <span className="text-[10px] font-medium bg-red-50 text-red-700 px-1.5 py-0.5 rounded-full w-fit">Overdue</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="bg-muted/20 border-t">
                          <td colSpan={canRecordPayment ? 6 : 5} className="px-4 py-2.5 text-xs text-muted-foreground font-medium">
                            {pendingBills.length} bill{pendingBills.length !== 1 ? "s" : ""} pending payment
                            {pendingTotalPages > 1 && ` · page ${pendingPage} of ${pendingTotalPages}`}
                          </td>
                          <td colSpan={3} className="px-4 py-2.5 text-right font-bold text-sm">
                            ₹{pendingBills.reduce((s, b) => s + Math.max(0, Number(b.total_amount) + Number(b.gst_amount ?? 0) - Number(b.amount_paid ?? 0)), 0).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Pagination for pending bills */}
                  {pendingTotalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 mt-3">
                      <button
                        className="px-3 py-1.5 text-xs rounded-md border hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => setPendingPage((p) => Math.max(1, p - 1))}
                        disabled={pendingPage === 1}
                      >
                        ← Prev
                      </button>
                      {Array.from({ length: pendingTotalPages }, (_, i) => i + 1).map((p) => (
                        <button
                          key={p}
                          onClick={() => setPendingPage(p)}
                          className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${p === pendingPage ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted/50"}`}
                        >
                          {p}
                        </button>
                      ))}
                      <button
                        className="px-3 py-1.5 text-xs rounded-md border hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => setPendingPage((p) => Math.min(pendingTotalPages, p + 1))}
                        disabled={pendingPage === pendingTotalPages}
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Payment History */}
              {(allPaidBills.length > 0 || filters.q) && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <History className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase">Payment History</h3>
                    <span className="text-xs text-muted-foreground">
                      ({allPaidBills.length} bill{allPaidBills.length !== 1 ? "s" : ""})
                    </span>
                  </div>

                  {allPaidBills.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center border rounded-lg">No paid bills match your search.</p>
                  ) : (
                    <>
                      <div className="rounded-lg border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-muted/20 border-b">
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground">Bill #</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground">Vendor</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground hidden md:table-cell">PO</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground hidden xl:table-cell">Class</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground hidden sm:table-cell">Invoice Date</th>
                              <th className="px-4 py-2.5 text-right font-medium text-xs text-muted-foreground">Amount</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground hidden sm:table-cell">Payment Date</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground hidden lg:table-cell">Payment Ref</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visiblePaidBills.map((bill) => (
                              <tr
                                key={bill.id}
                                className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                                onClick={() => router.push(`/accounting/vendor-payments/${bill.id}`)}
                              >
                                <td className="px-4 py-2.5 font-mono text-xs font-medium">
                                  {bill.bill_number}
                                  {bill.invoice_number && (
                                    <p className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-muted-foreground"
                                       onClick={(e) => e.stopPropagation()}>
                                      <FileText className="h-2.5 w-2.5 shrink-0" />
                                      {bill.invoice_file_url ? (
                                        <a
                                          href={bill.invoice_file_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="font-mono text-blue-600 hover:text-blue-800 hover:underline"
                                          title="View vendor invoice"
                                        >
                                          {bill.invoice_number}
                                        </a>
                                      ) : (
                                        <span className="font-mono">{bill.invoice_number}</span>
                                      )}
                                    </p>
                                  )}
                                  {bill.approved_at && (
                                    <p
                                      className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-emerald-700"
                                      title={bill.approval_code ? `Approval code: ${bill.approval_code}` : "Approved"}
                                    >
                                      <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
                                      <span className="truncate">
                                        {bill.approver?.full_name ?? "—"} · {formatSmartDate(bill.approved_at)}
                                      </span>
                                    </p>
                                  )}
                                </td>
                                <td className="px-4 py-2.5">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <p className="font-medium truncate max-w-[140px] text-xs">
                                      {bill.procurement_vendors?.name ?? "—"}
                                    </p>
                                    {bill.procurement_vendors?.id && !bill.procurement_vendors.contact_email?.trim() && (
                                      <VendorEmailChip vendorId={bill.procurement_vendors.id} />
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5 hidden md:table-cell text-muted-foreground text-xs">
                                  {bill.purchase_orders?.po_number ?? "—"}
                                </td>
                                <td className="px-4 py-2.5 hidden xl:table-cell">
                                  {(() => {
                                    const effectiveDept = bill.manual_department ?? bill.purchase_orders?.purchase_requests?.department ?? null;
                                    const effectiveExpType = bill.manual_expenditure_type ?? bill.purchase_orders?.purchase_requests?.expenditure_type ?? null;
                                    const expClass = classifyExpense(effectiveDept, effectiveExpType);
                                    return (
                                      <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${EXPENSE_CLASS_COLORS[expClass]}`}>
                                        {EXPENSE_CLASS_LABELS[expClass]}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-muted-foreground">
                                  {bill.invoice_date
                                    ? new Date(bill.invoice_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "2-digit" })
                                    : "—"}
                                </td>
                                <td className="px-4 py-2.5 text-right text-xs font-medium">
                                  <div>
                                    <p>₹{Number(bill.total_amount).toLocaleString("en-IN", { minimumFractionDigits: 0 })}</p>
                                    {Number(bill.gst_rate ?? 0) > 0 && (
                                      <p className="text-[10px] text-blue-600 font-normal">+₹{Number(bill.gst_amount ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 0 })} GST</p>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-muted-foreground">
                                  {bill.payment_date
                                    ? new Date(bill.payment_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "2-digit" })
                                    : "—"}
                                </td>
                                <td className="px-4 py-2.5 hidden lg:table-cell text-xs font-mono text-muted-foreground max-w-[160px]">
                                  {bill.vendor_bill_payments && bill.vendor_bill_payments.length > 0
                                    ? [...new Set(bill.vendor_bill_payments.map((p) => p.payment_reference).filter(Boolean))].join(", ") || "—"
                                    : "—"}
                                </td>
                                <td className="px-4 py-2.5">
                                  <div className="flex flex-col gap-1 items-start">
                                    <span className="text-[10px] font-medium bg-green-100 text-green-800 px-1.5 py-0.5 rounded-full">Paid</span>
                                    {bill.payment_mode === "cheque" && !bill.cheque_signed_at && (
                                      <span className="text-[10px] font-medium bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full whitespace-nowrap">⚠ Sign cheque</span>
                                    )}
                                    {bill.payment_mode === "cheque" && bill.cheque_signed_at && (
                                      <span className="text-[10px] font-medium bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded-full whitespace-nowrap">✓ Cheque signed</span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {allPaidBills.length > historyLimit && (
                        <button
                          className="mt-3 w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground py-2 border border-dashed rounded-lg hover:border-border transition-colors"
                          onClick={() => setHistoryLimit((prev) => prev + 10)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                          Show more ({allPaidBills.length - historyLimit} remaining)
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── Petty Cash ───────────────────────────────────────────────── */}
        <TabsContent value="petty-cash" className="mt-4">
          <PettyCashIssuance />
        </TabsContent>

        {/* ── TDS Payable ──────────────────────────────────────────────── */}
        <TabsContent value="tds" className="mt-0">
          <TdsPayablePage />
        </TabsContent>

        {/* ── Rent Payments ────────────────────────────────────────────── */}
        <TabsContent value="rent" className="mt-4 space-y-4">
          {/* View toggle */}
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <button
                className={cn("text-sm px-3 py-1.5 rounded-md border transition-colors", rentView === "pending" ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted")}
                onClick={() => setRentView("pending")}
              >
                Approved — Ready to Pay
              </button>
              <button
                className={cn("text-sm px-3 py-1.5 rounded-md border transition-colors", rentView === "paid" ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted")}
                onClick={() => setRentView("paid")}
              >
                Recently Paid (90 days)
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{rentPayments.length} record(s)</p>
          </div>

          {rentLoading ? (
            <div className="space-y-2">
              {[1,2,3].map((i) => <div key={i} className="h-16 animate-pulse bg-muted rounded-lg" />)}
            </div>
          ) : rentPayments.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground border rounded-lg bg-muted/20">
              {rentView === "pending" ? "No approved rent payments awaiting payment" : "No paid rent entries in the last 90 days"}
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium">Location</th>
                    <th className="text-left px-4 py-3 font-medium">Landlord</th>
                    <th className="text-left px-4 py-3 font-medium">Month</th>
                    <th className="text-left px-4 py-3 font-medium">Due</th>
                    <th className="text-right px-4 py-3 font-medium">Gross Rent</th>
                    <th className="text-right px-4 py-3 font-medium">TDS</th>
                    <th className="text-right px-4 py-3 font-medium">Net Payable</th>
                    <th className="text-left px-4 py-3 font-medium">Bank (Primary)</th>
                    {rentView === "paid" && <th className="text-left px-4 py-3 font-medium">Paid On</th>}
                    {rentView === "pending" && <th className="text-left px-4 py-3 font-medium">Status</th>}
                    <th className="text-left px-4 py-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rentPayments.map((p) => (
                    <tr key={p.id} className="border-b hover:bg-muted/20">
                      <td className="px-4 py-3 font-medium">{p.lease?.location?.name ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div>
                          <p>{p.lease?.landlord?.name ?? "—"}</p>
                          {p.lease?.landlord?.pan_number && (
                            <p className="text-xs text-muted-foreground font-mono">{p.lease.landlord.pan_number}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">{p.payment_month}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(p.due_date)}</td>
                      <td className="px-4 py-3 text-right">{formatCurrency(p.gross_rent_amount)}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{formatCurrency(p.tds_amount)}</td>
                      <td className="px-4 py-3 text-right font-semibold">{formatCurrency(p.net_payable)}</td>
                      <td className="px-4 py-3">
                        {p.primary_bank ? (
                          <div className="text-xs">
                            <p className="font-medium">{p.primary_bank.bank_name}</p>
                            <p className="text-muted-foreground font-mono">{p.primary_bank.account_number}</p>
                            <p className="text-muted-foreground">{p.primary_bank.ifsc_code}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">No bank set</span>
                        )}
                      </td>
                      {rentView === "paid" && (
                        <td className="px-4 py-3 text-sm">
                          <div>
                            <p>{p.paid_date ? formatDate(p.paid_date) : "—"}</p>
                            {p.payment_mode && <p className="text-xs text-muted-foreground uppercase">{p.payment_mode}</p>}
                            {p.payment_reference && <p className="text-xs font-mono text-muted-foreground">{p.payment_reference}</p>}
                          </div>
                        </td>
                      )}
                      {rentView === "pending" && (
                        <td className="px-4 py-3">
                          {p.status === "on_hold" ? (
                            <div className="flex items-center gap-1">
                              <PauseCircle className="h-3.5 w-3.5 text-orange-500" />
                              <span className="text-xs text-orange-700 max-w-28 truncate" title={p.on_hold_reason ?? undefined}>{p.on_hold_reason ?? "On Hold"}</span>
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5">
                              <CheckCircle2 className="h-3 w-3" />Approved
                            </span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        {rentView === "pending" && p.status === "approved" && canRecordPayment && (
                          <button
                            className="text-xs bg-green-600 hover:bg-green-700 text-white px-2.5 py-1 rounded transition-colors"
                            onClick={() => {
                              setMarkPaidDialog({ open: true, payment: p });
                              setMarkPaidForm({
                                paid_date: new Date().toISOString().split("T")[0],
                                payment_mode: "neft",
                                payment_reference: "",
                                bank_account_id: p.primary_bank?.id ?? "",
                              });
                            }}
                          >
                            Mark Paid
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Mark Rent Payment Paid Dialog ─────────────────────────────────── */}
      <Dialog open={markPaidDialog.open} onOpenChange={(o) => { if (!markPaidSubmitting) setMarkPaidDialog({ open: o, payment: markPaidDialog.payment }); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark Rent Payment as Paid</DialogTitle>
            {markPaidDialog.payment && (
              <p className="text-sm text-muted-foreground pt-1">
                {markPaidDialog.payment.lease?.location?.name} · {markPaidDialog.payment.payment_month} · {formatCurrency(markPaidDialog.payment.net_payable)} net
              </p>
            )}
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Paid Date *</Label>
                <Input type="date" value={markPaidForm.paid_date} onChange={(e) => setMarkPaidForm((f) => ({ ...f, paid_date: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Payment Mode</Label>
                <Select value={markPaidForm.payment_mode} onValueChange={(v) => setMarkPaidForm((f) => ({ ...f, payment_mode: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="neft">NEFT</SelectItem>
                    <SelectItem value="rtgs">RTGS</SelectItem>
                    <SelectItem value="imps">IMPS</SelectItem>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    <SelectItem value="cheque">Cheque</SelectItem>
                    <SelectItem value="upi">UPI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>UTR / Reference Number *</Label>
              <Input
                placeholder="e.g. HDFC123456789012"
                value={markPaidForm.payment_reference}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, payment_reference: e.target.value }))}
              />
            </div>
            {markPaidDialog.payment?.lease?.landlord?.bank_accounts && markPaidDialog.payment.lease.landlord.bank_accounts.length > 1 && (
              <div className="space-y-2">
                <Label>Bank Account (optional)</Label>
                <Select value={markPaidForm.bank_account_id} onValueChange={(v) => setMarkPaidForm((f) => ({ ...f, bank_account_id: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                  <SelectContent>
                    {markPaidDialog.payment.lease.landlord.bank_accounts.map((ba) => (
                      <SelectItem key={ba.id} value={ba.id}>
                        {ba.bank_name} — {ba.account_number} {ba.is_primary ? "(Primary)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <button className="text-sm px-4 py-2 border rounded hover:bg-muted" onClick={() => setMarkPaidDialog({ open: false, payment: null })}>Cancel</button>
            <button
              className="text-sm px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
              disabled={markPaidSubmitting || !markPaidForm.paid_date || !markPaidForm.payment_reference}
              onClick={handleMarkPaid}
            >
              {markPaidSubmitting ? "Saving..." : "Confirm Payment"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Batch Payment Wizard ─────────────────────────────────────────── */}
      <Dialog open={batchWizardOpen} onOpenChange={(open) => { if (!batchSubmitting) setBatchWizardOpen(open); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-emerald-600" />
              Batch Payment — {selectedBills.length} bills
            </DialogTitle>
          </DialogHeader>

          {/* Step 0: Bill review */}
          {batchStep === 0 && (
            <div className="space-y-4 py-1">
              <p className="text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2">
                Review the selected bills. GST will be confirmed per bill in the next steps, and payment details collected at the end.
              </p>
              <div className="rounded-lg border divide-y text-sm">
                {selectedBills.map((b) => {
                  const billBase = Number(b.approved_amount ?? b.total_amount);
                  return (
                    <div key={b.id} className="flex items-center justify-between px-3 py-2 gap-2">
                      <div className="min-w-0">
                        <span className="font-mono text-xs font-medium text-primary">{b.bill_number}</span>
                        <span className="text-muted-foreground text-xs ml-2 truncate">{b.procurement_vendors?.name}</span>
                        {b.invoice_number && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">Inv # <span className="font-mono">{b.invoice_number}</span></div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-medium text-xs">{formatCurrency(billBase)}</span>
                        <div className="text-[10px] text-muted-foreground">+ GST to confirm</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Steps 1..N: Per-bill GST confirmation */}
          {batchStep >= 1 && batchStep <= selectedBills.length && (() => {
            const bill = selectedBills[batchStep - 1];
            const gst = parseFloat(batchGst[bill.id] || "0") || 0;
            const base = Number(bill.approved_amount ?? bill.total_amount);
            const outstanding = Math.max(0, base + gst - Number(bill.amount_paid ?? 0));
            return (
              <div className="space-y-4 py-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Bill {batchStep} of {selectedBills.length}</span>
                  <div className="flex gap-1">
                    {selectedBills.map((_, i) => (
                      <span key={i} className={cn("h-1.5 w-5 rounded-full", i < batchStep ? "bg-emerald-500" : "bg-muted")} />
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border p-3 space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-medium text-primary">{bill.bill_number}</span>
                    <Badge variant="secondary" className="text-xs">{bill.procurement_vendors?.name ?? "—"}</Badge>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Base amount</span>
                    <span className="font-medium text-foreground">{formatCurrency(base)}</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bp_gst">GST Amount <span className="text-muted-foreground font-normal">(leave 0 if no GST)</span></Label>
                  <Input
                    id="bp_gst" type="number" min="0" step="0.01" placeholder="0.00"
                    value={batchGst[bill.id] ?? ""}
                    onChange={(e) => setBatchGst((prev) => ({ ...prev, [bill.id]: e.target.value }))}
                  />
                  {gst > 0 && <p className="text-xs text-muted-foreground">GST rate ≈ {((gst / base) * 100).toFixed(1)}%</p>}
                </div>
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-emerald-800">Amount to pay</span>
                  <span className="text-lg font-bold text-emerald-700">{formatCurrency(outstanding)}</span>
                </div>
                {/* Per-bill round-off */}
                {(() => {
                  const tds = batchTds[bill.id];
                  const tdsAmt = tds?.enabled && tds.baseAmount && tds.rate > 0
                    ? Math.round(Number(tds.baseAmount) * tds.rate) / 100 : 0;
                  const roundTarget = tds?.enabled && tdsAmt > 0 ? outstanding - tdsAmt : outstanding;
                  const rounded = Math.round(roundTarget);
                  const diff = rounded - roundTarget;
                  if (Math.abs(diff) < 0.005) return null;
                  return (
                    <div className="rounded-lg bg-slate-50 border px-3 py-2 text-xs space-y-1">
                      <div className="flex justify-between text-muted-foreground">
                        <span>{tds?.enabled && tdsAmt > 0 ? "Net to vendor (after TDS)" : "Payable (incl. GST)"}</span>
                        <span>{formatCurrency(roundTarget)}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>Round off</span>
                        <span className={cn("font-medium", diff > 0 ? "text-emerald-700" : "text-orange-600")}>
                          {diff > 0 ? "+" : "−"}{formatCurrency(Math.abs(diff))}
                        </span>
                      </div>
                      <div className="flex justify-between font-semibold text-foreground border-t pt-1">
                        <span>Issue for</span>
                        <span>{formatCurrency(rounded)}</span>
                      </div>
                    </div>
                  );
                })()}
                {/* Per-bill TDS deduction (optional) */}
                {(() => {
                  const tds = batchTds[bill.id] ?? { enabled: false, sectionCode: "", vendorType: "company" as const, rate: 0, rateMin: 0, rateMax: 20, baseAmount: "", panAvailable: true };
                  const tdsAmt = tds.enabled && tds.baseAmount && tds.rate > 0
                    ? Math.round(Number(tds.baseAmount) * tds.rate) / 100 : 0;
                  const netToVendor = outstanding - tdsAmt;
                  return (
                    <div className="rounded-lg border border-dashed border-blue-300 bg-blue-50/40 p-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-blue-900">TDS Deduction</span>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={tds.enabled}
                            onChange={(e) => setBatchTds((prev) => ({ ...prev, [bill.id]: { ...tds, enabled: e.target.checked } }))}
                            className="h-3.5 w-3.5 rounded accent-blue-600"
                          />
                          <span className="text-xs text-blue-800">{tds.enabled ? "Enabled" : "Enable"}</span>
                        </label>
                      </div>
                      {tds.enabled && (
                        <div className="grid grid-cols-2 gap-2">
                          <div className="col-span-2 space-y-1">
                            <Label className="text-xs">TDS Section</Label>
                            <select
                              className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
                              value={tds.sectionCode}
                              onChange={(e) => {
                                const sec = batchTdsSections.find((s) => s.code === e.target.value);
                                const rate = sec ? (tds.panAvailable ? sec.rate_company : 20) : 0;
                                setBatchTds((prev) => ({ ...prev, [bill.id]: { ...tds, sectionCode: e.target.value, rate, rateMin: sec ? sec.rate_min : 0, rateMax: sec ? sec.rate_max : 20 } }));
                              }}
                            >
                              <option value="">Select section</option>
                              {batchTdsSections.map((s) => (
                                <option key={s.code} value={s.code}>{s.code.replace("_", "(")} — {s.description}{s.code.includes("_") ? ")" : ""}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Rate (%)</Label>
                            <Input
                              type="number" step="0.5" min={tds.rateMin} max={tds.rateMax}
                              value={tds.rate}
                              onChange={(e) => setBatchTds((prev) => ({ ...prev, [bill.id]: { ...tds, rate: Number(e.target.value) } }))}
                              className="h-8 text-xs"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Base amount (pre-GST)</Label>
                            <Input
                              type="number" step="0.01" min="0.01" placeholder="Amt excl. GST"
                              value={tds.baseAmount}
                              onChange={(e) => setBatchTds((prev) => ({ ...prev, [bill.id]: { ...tds, baseAmount: e.target.value } }))}
                              className="h-8 text-xs"
                            />
                          </div>
                          {tdsAmt > 0 && (
                            <div className="col-span-2 rounded bg-blue-100/60 px-2.5 py-1.5 text-xs space-y-0.5">
                              <div className="flex justify-between">
                                <span className="text-blue-700">TDS deducted ({tds.rate}%):</span>
                                <span className="font-semibold text-blue-900">– {formatCurrency(tdsAmt)}</span>
                              </div>
                              <div className="flex justify-between border-t border-blue-200 pt-0.5 mt-0.5">
                                <span className="text-blue-700">Net to vendor:</span>
                                <span className="font-bold text-blue-900">{formatCurrency(netToVendor)}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Final step: Payment details + confirmed summary */}
          {batchStep === selectedBills.length + 1 && (() => {
            const totalWithGst = selectedBills.reduce((s, b) => {
              const gst = parseFloat(batchGst[b.id] || "0") || 0;
              const base = Number(b.approved_amount ?? b.total_amount);
              return s + Math.max(0, base + gst - Number(b.amount_paid ?? 0));
            }, 0);
            return (
              <div className="space-y-4 py-1">
                {/* Bill summary with confirmed GST */}
                <div className="rounded-lg border divide-y text-sm">
                  <div className="grid grid-cols-4 px-3 py-2 text-xs font-semibold text-muted-foreground bg-muted/40">
                    <span>Bill</span><span>Vendor</span><span className="text-right">GST</span><span className="text-right">Total</span>
                  </div>
                  {selectedBills.map((b) => {
                    const gst = parseFloat(batchGst[b.id] || "0") || 0;
                    const base = Number(b.approved_amount ?? b.total_amount);
                    const total = Math.max(0, base + gst - Number(b.amount_paid ?? 0));
                    return (
                      <div key={b.id} className="grid grid-cols-4 px-3 py-2.5 items-center">
                        <span className="font-mono text-xs font-medium text-primary">{b.bill_number}</span>
                        <span className="truncate text-xs text-muted-foreground pr-2">{b.procurement_vendors?.name ?? "—"}</span>
                        <span className="text-right text-xs">{gst > 0 ? formatCurrency(gst) : "—"}</span>
                        <span className="text-right font-semibold">{formatCurrency(total)}</span>
                      </div>
                    );
                  })}
                  <div className="grid grid-cols-4 px-3 py-2.5 bg-emerald-50 font-bold text-emerald-800">
                    <span className="col-span-3">Grand total</span>
                    <span className="text-right text-emerald-700">{formatCurrency(totalWithGst)}</span>
                  </div>
                  {/* Round-off rows — only when grand total has paise */}
                  {(() => {
                    const rounded = Math.round(totalWithGst);
                    const diff = rounded - totalWithGst;
                    if (Math.abs(diff) < 0.005) return null;
                    return (
                      <>
                        <div className="grid grid-cols-4 px-3 py-2 text-xs text-muted-foreground bg-muted/20">
                          <span className="col-span-3">Round off</span>
                          <span className={cn("text-right font-medium", diff > 0 ? "text-emerald-700" : "text-orange-600")}>
                            {diff > 0 ? "+" : "−"}{formatCurrency(Math.abs(diff))}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 px-3 py-2.5 bg-emerald-100 font-bold text-emerald-900 border-t border-emerald-300">
                          <span className="col-span-3">Issue cheque / NEFT for</span>
                          <span className="text-right">{formatCurrency(rounded)}</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
                {/* Payment fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="bp_date">Payment Date <span className="text-red-500">*</span></Label>
                    <Input id="bp_date" type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bp_mode">Payment Mode <span className="text-red-500">*</span></Label>
                    <Select value={batchMode} onValueChange={setBatchMode}>
                      <SelectTrigger id="bp_mode"><SelectValue placeholder="Select mode" /></SelectTrigger>
                      <SelectContent>
                        {allBatchPayModes.map((m) => (
                          <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bp_ref">UTR / Reference Number <span className="text-red-500">*</span></Label>
                  <Input id="bp_ref" placeholder="e.g. UTR123456789012" value={batchRef} onChange={(e) => setBatchRef(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bp_notes">Notes <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Textarea id="bp_notes" placeholder="e.g. May vendor payments" value={batchNotes} onChange={(e) => setBatchNotes(e.target.value)} rows={2} />
                </div>
              </div>
            );
          })()}

          <DialogFooter className="gap-2 sm:gap-0">
            {batchStep > 0 && (
              <button
                onClick={() => setBatchStep((s) => s - 1)}
                disabled={batchSubmitting}
                className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted/50 disabled:opacity-50"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            )}
            {batchStep === 0 && (
              <button onClick={() => setBatchWizardOpen(false)} className="inline-flex items-center rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
                Cancel
              </button>
            )}
            {batchStep < selectedBills.length + 1 && (
              <button
                onClick={() => setBatchStep((s) => s + 1)}
                disabled={batchSubmitting}
                className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm hover:bg-primary/90 disabled:opacity-50"
              >
                {batchStep === selectedBills.length ? "Payment Details" : "Next"} <ArrowRight className="h-4 w-4" />
              </button>
            )}
            {batchStep === selectedBills.length + 1 && (
              <button
                onClick={handleBatchSubmit}
                disabled={batchSubmitting}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 text-sm disabled:opacity-50"
              >
                {batchSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm Payment
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Accounting Classification Dialog ─────────────────────────────── */}
      <Dialog open={!!tagDialogBillId} onOpenChange={(open) => { if (!tagSubmitting && !open) setTagDialogBillId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Tag Accounting Classification</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <p className="text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2">
              Set the department and expenditure type so accounts can post this bill to the correct cost centre.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="tag_dept">Department</Label>
              <Select value={tagDept} onValueChange={setTagDept}>
                <SelectTrigger id="tag_dept">
                  <SelectValue placeholder="Select department…" />
                </SelectTrigger>
                <SelectContent>
                  {PROCUREMENT_DEPARTMENTS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {PROCUREMENT_DEPARTMENT_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tag_exptype">Expenditure Type</Label>
              <Select value={tagExpType} onValueChange={setTagExpType}>
                <SelectTrigger id="tag_exptype">
                  <SelectValue placeholder="Select type…" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXPENDITURE_TYPE_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {tagDept && tagExpType && (
              <div className={`rounded-lg px-3 py-2 text-xs font-medium border ${EXPENSE_CLASS_COLORS[classifyExpense(tagDept, tagExpType)]}`}>
                This bill will be classified as <strong>{EXPENSE_CLASS_LABELS[classifyExpense(tagDept, tagExpType)]}</strong>
                {" "}({PROCUREMENT_DEPARTMENT_LABELS[tagDept as keyof typeof PROCUREMENT_DEPARTMENT_LABELS]} · {EXPENDITURE_TYPE_LABELS[tagExpType] ?? tagExpType})
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              onClick={() => setTagDialogBillId(null)}
              disabled={tagSubmitting}
              className="rounded-md border px-3 py-2 text-sm hover:bg-muted/50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleTagSubmit}
              disabled={tagSubmitting || !tagDept || !tagExpType}
              className="rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {tagSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save Classification
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Release PO Advance dialog ─────────────────────────────────────── */}
      <Dialog open={!!processingAdvance} onOpenChange={(o) => { if (!o && !advanceSubmitting) setProcessingAdvance(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Release advance — {processingAdvance?.po_number}</DialogTitle>
          </DialogHeader>
          {processingAdvance && (
            <div className="space-y-4 py-2 text-sm">
              <div className="rounded-md bg-muted/40 p-3 space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Vendor</span>
                  <span className="font-medium">{processingAdvance.procurement_vendors?.name ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Advance amount</span>
                  <span className="font-semibold text-purple-800">{formatCurrency(processingAdvance.advance_amount)}</span>
                </div>
                {processingAdvance.payment_terms && (
                  <div className="text-[11px] text-muted-foreground italic pt-1">
                    Terms: &ldquo;{processingAdvance.payment_terms}&rdquo;
                  </div>
                )}
                {processingAdvance.proforma?.signed_url && (
                  <a
                    href={processingAdvance.proforma.signed_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-purple-700 hover:underline pt-1"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    View proforma ({processingAdvance.proforma.file_name})
                  </a>
                )}
              </div>

              <div className="space-y-1">
                <Label>Payment mode <span className="text-red-500">*</span></Label>
                <select
                  value={advanceForm.payment_mode}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, payment_mode: e.target.value as typeof advanceForm.payment_mode })}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="neft">NEFT</option>
                  <option value="rtgs">RTGS</option>
                  <option value="imps">IMPS</option>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cheque">Cheque</option>
                  {(currentUserRole === "admin" || currentUserRole === "office_admin") && (
                    <option value="cash">Cash / Petty Cash</option>
                  )}
                </select>
              </div>

              <div className="space-y-1">
                <Label>Reference / UTR / Cheque # <span className="text-red-500">*</span></Label>
                <Input
                  value={advanceForm.payment_reference}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, payment_reference: e.target.value })}
                  placeholder="e.g. UTR123456789"
                />
              </div>

              <div className="space-y-1">
                <Label>Payment date</Label>
                <Input
                  type="date"
                  value={advanceForm.payment_date}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, payment_date: e.target.value })}
                />
              </div>

              <p className="text-[11px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-3 py-2">
                Confirms that <strong>{formatCurrency(processingAdvance.advance_amount)}</strong> has been transferred to the vendor. The PO will move to <em>advance processed</em>, and the linked bill (when uploaded) will auto-credit this amount.
              </p>
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => setProcessingAdvance(null)}
              disabled={advanceSubmitting}
              className="px-3 py-1.5 text-sm rounded-md border hover:bg-muted/50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleProcessAdvance}
              disabled={advanceSubmitting || !advanceForm.payment_reference.trim()}
              className="px-3 py-1.5 text-sm rounded-md bg-purple-600 hover:bg-purple-700 text-white font-medium disabled:opacity-50"
            >
              {advanceSubmitting ? "Releasing…" : "Confirm & release"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

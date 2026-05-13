"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  FileText,
  Receipt,
  MoreHorizontal,
  Eye,
  Download,
  CheckCircle,
  Upload,
  X,
  IndianRupee,
  ScrollText,
  RefreshCcw,
  Send,
  FileCheck,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { AddUsageChargeDialog } from "@/components/billing/add-usage-charge-dialog";
import { GenerateStatementDialog } from "@/components/billing/generate-statement-dialog";
import { ViewStatementDialog } from "@/components/billing/view-statement-dialog";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";
import { formatDate, formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { MonthPicker } from "@/components/accounting/month-picker";
import { PeriodStatusBar } from "@/components/accounting/period-status-bar";
import { AgingBuckets } from "@/components/accounting/aging-buckets";
import { ContractAccountingRow } from "@/components/accounting/contract-accounting-row";
import { ActionRequiredBanner } from "@/components/accounting/action-required-banner";
import { FinanceGuideCard, GuideReopenButton } from "@/components/finance/finance-guide-card";
// Per-tab components are dynamic-imported so the JS for tabs the user
// never opens isn't downloaded. Each loader shows a small skeleton block.
// SSR off because all four are client-state-driven (filters, dialogs).
const WalkinCollectionsTable = dynamic(() => import("@/components/accounting/walkin-collections-table").then(m => m.WalkinCollectionsTable), { ssr: false, loading: () => <TabLoading label="Walk-in" /> });
const CashHandoverTable      = dynamic(() => import("@/components/accounting/cash-handover-table").then(m => m.CashHandoverTable),           { ssr: false, loading: () => <TabLoading label="Cash" /> });
const GstInvoiceEntry        = dynamic(() => import("@/components/accounting/gst-invoice-entry").then(m => m.GstInvoiceEntry),               { ssr: false, loading: () => <TabLoading label="GST" /> });
const ProposalPaymentsTab    = dynamic(() => import("@/components/accounting/proposal-payments-tab").then(m => m.ProposalPaymentsTab),       { ssr: false, loading: () => <TabLoading label="Proposals" /> });
const ExportSummaryDialog    = dynamic(() => import("@/components/accounting/export-summary-dialog").then(m => m.ExportSummaryDialog),       { ssr: false });
const RefundsTab             = dynamic(() => import("@/components/billing/refunds-tab").then(m => m.RefundsTab),                              { ssr: false, loading: () => <TabLoading label="Refunds" /> });
const RetainedPaymentsTab    = dynamic(() => import("@/components/billing/retained-payments-tab").then(m => m.RetainedPaymentsTab),           { ssr: false, loading: () => <TabLoading label="Retained Payments" /> });

function TabLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
      <span className="h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
      Loading {label}…
    </div>
  );
}
import { createClient } from "@/lib/supabase/client";

// ── Status maps ──────────────────────────────────────────────────────────────

const USAGE_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  billed:  "bg-green-100 text-green-800",
  waived:  "bg-gray-100 text-gray-800",
};
const USAGE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  billed:  "Billed",
  waived:  "Waived",
};
const STATEMENT_STATUS_LABELS: Record<string, string> = {
  draft:     "Draft",
  finalized: "Finalized",
  exported:  "Exported",
  voided:    "Voided",
};

// ── Types — billing ──────────────────────────────────────────────────────────

interface ContractFilter {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
}

interface UsageCharge {
  id: string;
  description: string;
  contract_id?: string | null;
  contract?: { contract_number: string; billing_cycle?: string } | null;
  booking_id?: string | null;
  booking?: { booking_number: string; booking_date: string } | null;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  quantity: number;
  unit_price: number;
  total: number;
  gst_rate?: number;
  gst_amount?: number;
  total_with_gst?: number;
  charge_date: string;
  status: string;
  notes?: string;
}

interface BillingStatement {
  id: string;
  statement_number: string;
  contract_id?: string | null;
  booking_id?: string | null;
  contract?: { contract_number: string } | null;
  booking?: { booking_number: string; booking_date: string; guest_name?: string } | null;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  period_start: string;
  period_end: string;
  fixed_amount: number;
  usage_amount: number;
  total_amount: number;
  status: string;
  notes?: string;
  // Lifecycle fields
  emailed_at?: string | null;
  razorpay_payment_link_url?: string | null;
  payment_status?: string | null;
  accounted?: boolean | null;
  finalized_at?: string | null;
  gst_invoice_number?: string | null;
  voided_statement_id?: string | null;
  proforma_sent_at?: string | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ── Types — monthly summary ──────────────────────────────────────────────────

interface AgingBucket {
  count: number;
  total: number;
  contracts: string[];
}

interface ContractSummary {
  contract: {
    id: string;
    contract_number: string;
    title: string;
    monthly_membership_fee: number;
    lead?: {
      id: string;
      first_name: string;
      last_name: string;
      company?: string;
      email?: string;
      secondary_email?: string;
    };
  };
  recurring_amount: number;
  facility_usage_total: number;
  facility_usages: unknown[];
  ad_hoc_total: number;
  ad_hoc_charges: unknown[];
  booking_total: number;
  posted_bookings: unknown[];
  current_month_charges: number;
  carried_forward: number;
  total_owed: number;
  payments: unknown[];
  total_paid_this_month: number;
  outstanding: number;
  gst_invoice: unknown;
}

interface WalkinPayment {
  id: string;
  amount: number;
  payment_mode: string;
  status: string;
  created_at: string;
  booking?: {
    id: string;
    booking_date: string;
    guest_name?: string;
    guest_company?: string;
    customer_type?: string;
    space?: { name: string };
    lead?: { first_name: string; last_name: string; company?: string };
  };
}

interface CashHandoverItem {
  id: string;
  amount: number;
  payment_date?: string;
  cash_handover_status: string;
  collected_at?: string;
  handed_over_at?: string;
  handover_notes?: string;
  source: "contract" | "booking";
  display_name: string;
  reference: string;
  payment_number?: string;
  collector?: { full_name: string } | null;
  handover_receiver?: { full_name: string } | null;
}

interface GstEntry {
  contract_id: string;
  contract_number: string;
  company: string;
  lead_email?: string;
  lead_secondary_email?: string;
  total_billable: number;
  total_paid: number;
  payment_id: string | null;
  gst_invoice_number: string | null;
  gst_invoice_path: string | null;
  gst_invoice_status: string | null;
  gst_invoice_sent_at: string | null;
  gst_invoice_sent_to: string | null;
}

interface MonthlySummary {
  period: {
    id: string;
    status: string;
    locked_at?: string;
    locker?: { full_name: string } | null;
  } | null;
  year: number;
  month: number;
  period_start: string;
  period_end: string;
  contracts: ContractSummary[];
  walkin_payments: WalkinPayment[];
  totals: {
    total_billable: number;
    total_collected: number;
    total_outstanding: number;
    total_carried_forward: number;
    cash_pending_handover: number;
    cash_handed_over: number;
  };
  aging_buckets: {
    current: AgingBucket;
    overdue_30: AgingBucket;
    overdue_60: AgingBucket;
    overdue_90: AgingBucket;
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const now = new Date();

  // ── Month ─────────────────────────────────────────────────────────────────
  const [year, setYear]   = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // ── Monthly summary state ─────────────────────────────────────────────────
  const [summary, setSummary]             = useState<MonthlySummary | null>(null);
  const [cashHandovers, setCashHandovers] = useState<CashHandoverItem[]>([]);
  const [gstEntries, setGstEntries]       = useState<GstEntry[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [userRole, setUserRole]           = useState<string | null>(null);
  const [isLocking, setIsLocking]         = useState(false);
  const [showExport, setShowExport]       = useState(false);

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("tab") ?? "contracts";
    }
    return "contracts";
  });

  // ── Section grouping (Phase 3 finance consolidation) ─────────────────────
  // The 7 underlying tabs roll up into 3 finance-friendly buckets so the page
  // doesn't feel like a scavenger hunt. Each section renders its own
  // sub-tabs; the existing TabsContent components stay untouched.
  const SECTION_TABS = {
    receivables: ["contracts", "proposals", "usage-charges"],
    collections: ["walkin", "cash", "refunds"],
    invoicing:   ["gst", "statements", "retained-payments"],
  } as const;
  type Section = keyof typeof SECTION_TABS;
  const sectionForTab = (tab: string): Section => {
    for (const s of Object.keys(SECTION_TABS) as Section[]) {
      if ((SECTION_TABS[s] as readonly string[]).includes(tab)) return s;
    }
    return "receivables";
  };
  const [section, setSection] = useState<Section>(() => sectionForTab(activeTab));

  // Keep section in sync when activeTab changes via deep links (e.g. the
  // ActionRequiredBanner buttons that flip directly to "cash" or "gst").
  useEffect(() => {
    const next = sectionForTab(activeTab);
    if (next !== section) setSection(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleSectionChange = (next: Section) => {
    setSection(next);
    // If the current tab isn't part of the new section, jump to the section's
    // first tab so the user sees real content instead of an empty area.
    if (!(SECTION_TABS[next] as readonly string[]).includes(activeTab)) {
      setActiveTab(SECTION_TABS[next][0]);
    }
  };

  // ── Usage Charges ─────────────────────────────────────────────────────────
  const [charges, setCharges]                         = useState<UsageCharge[]>([]);
  const [chargesPagination, setChargesPagination]     = useState<Pagination>({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [chargesLoading, setChargesLoading]           = useState(true);
  const [chargesPage, setChargesPage]                 = useState(1);
  const [chargesContractFilter, setChargesContractFilter] = useState("");
  const [chargesStatusFilter, setChargesStatusFilter] = useState("");
  const [chargesDateFrom, setChargesDateFrom]         = useState("");
  const [chargesDateTo, setChargesDateTo]             = useState("");
  const [addChargeOpen, setAddChargeOpen]             = useState(false);

  // ── Billing Statements ────────────────────────────────────────────────────
  const [statements, setStatements]                       = useState<BillingStatement[]>([]);
  const [statementsPagination, setStatementsPagination]   = useState<Pagination>({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [statementsLoading, setStatementsLoading]         = useState(true);
  const [statementsPage, setStatementsPage]               = useState(1);
  const [statementsContractFilter, setStatementsContractFilter] = useState("");
  const [statementsStatusFilter, setStatementsStatusFilter]     = useState("");
  const [generateStatementOpen, setGenerateStatementOpen] = useState(false);
  const [generatingMissing, setGeneratingMissing] = useState(false);

  // "Generate Missing Bills" — re-runs the auto-generate logic for the current
  // month so any contracts activated mid-month (after the cron ran on the 1st)
  // get their billing statement created right away. Idempotent: contracts that
  // already have a statement for the period are skipped.
  const handleGenerateMissingBills = async () => {
    setGeneratingMissing(true);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to generate bills");
      } else if (json.generated === 0 && json.skipped === 0) {
        toast.info("No active contracts need bills for this month");
      } else if (json.generated === 0) {
        toast.info(`All ${json.skipped} active contract${json.skipped > 1 ? "s" : ""} already have bills for this month`);
      } else {
        toast.success(
          `Generated ${json.generated} draft bill${json.generated > 1 ? "s" : ""}` +
          (json.skipped > 0 ? ` (${json.skipped} already existed)` : "")
        );
        await fetchStatements();
      }
      if (json.errors?.length) {
        for (const e of json.errors) toast.error(e);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate bills");
    } finally {
      setGeneratingMissing(false);
    }
  };
  const [viewStatementId, setViewStatementId]             = useState<string | null>(null);

  // ── Record Payment dialog ─────────────────────────────────────────────────
  const [recordPaymentDialogOpen, setRecordPaymentDialogOpen]   = useState(false);
  const [recordPaymentStatementId, setRecordPaymentStatementId] = useState<string | null>(null);
  const [rpAmount, setRpAmount]       = useState("");
  const [rpDate, setRpDate]           = useState(now.toISOString().slice(0, 10));
  const [rpMode, setRpMode]           = useState("neft");
  const [rpReference, setRpReference] = useState("");
  const [rpNotes, setRpNotes]         = useState("");
  const [rpSubmitting, setRpSubmitting] = useState(false);

  // ── Void Statement dialog ────────────────────────────────────────────────
  const [voidDialogOpen, setVoidDialogOpen]       = useState(false);
  const [voidStatementId, setVoidStatementId]     = useState<string | null>(null);
  const [voidReason, setVoidReason]               = useState("");
  const [voidSubmitting, setVoidSubmitting]       = useState(false);

  // ── Contract list for filter dropdowns ───────────────────────────────────
  const [contractFilters, setContractFilters] = useState<ContractFilter[]>([]);

  // ── Get user role ────────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        const { data } = await supabase
          .from("users").select("role").eq("auth_id", user.id).single();
        setUserRole(data?.role || "sales_rep");
      }
    });
  }, []);

  // ── Fetch monthly summary (with AbortController for cleanup) ─────────────
  const summaryControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setSummaryLoading(true);
    try {
      const [summaryRes, cashRes, gstRes] = await Promise.all([
        fetch(`/api/accounting/monthly-summary?year=${year}&month=${month}`, { signal }),
        fetch(`/api/accounting/cash-handovers?year=${year}&month=${month}`, { signal }),
        fetch(`/api/accounting/gst-invoices?year=${year}&month=${month}`, { signal }),
      ]);
      if (signal?.aborted) return;
      if (summaryRes.ok) setSummary((await summaryRes.json()).data);
      if (cashRes.ok)    setCashHandovers((await cashRes.json()).data || []);
      if (gstRes.ok)     setGstEntries((await gstRes.json()).data || []);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load billing data");
    } finally {
      if (!signal?.aborted) setSummaryLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    summaryControllerRef.current?.abort();
    const controller = new AbortController();
    summaryControllerRef.current = controller;
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  // ── Fetch contracts for filter dropdowns ─────────────────────────────────
  useEffect(() => {
    fetch("/api/contracts?limit=100")
      .then((r) => r.json())
      .then((j) => setContractFilters(j.data || []))
      .catch(() => {});
  }, []);

  // ── Fetch usage charges (with AbortController) ──────────────────────────
  const chargesControllerRef = useRef<AbortController | null>(null);

  const fetchCharges = useCallback(async (signal?: AbortSignal) => {
    setChargesLoading(true);
    try {
      const params = new URLSearchParams({ page: String(chargesPage), limit: "25" });
      if (chargesContractFilter) params.set("contract_id", chargesContractFilter);
      if (chargesStatusFilter)   params.set("status", chargesStatusFilter);
      if (chargesDateFrom)       params.set("date_from", chargesDateFrom);
      if (chargesDateTo)         params.set("date_to", chargesDateTo);
      const res = await fetch(`/api/usage-charges?${params}`, { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const json = await res.json();
        setCharges(json.data || []);
        setChargesPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load usage charges");
    } finally {
      if (!signal?.aborted) setChargesLoading(false);
    }
  }, [chargesPage, chargesContractFilter, chargesStatusFilter, chargesDateFrom, chargesDateTo]);

  // Only fire on the Usage Charges tab — saves a round-trip on first load
  // for users who never open it.
  useEffect(() => {
    if (activeTab !== "usage-charges") return;
    chargesControllerRef.current?.abort();
    const controller = new AbortController();
    chargesControllerRef.current = controller;
    fetchCharges(controller.signal);
    return () => controller.abort();
  }, [activeTab, fetchCharges]);

  // ── Fetch billing statements (with AbortController) ────────────────────
  const statementsControllerRef = useRef<AbortController | null>(null);

  const fetchStatements = useCallback(async (signal?: AbortSignal) => {
    setStatementsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(statementsPage), limit: "25" });
      if (statementsContractFilter) params.set("contract_id", statementsContractFilter);
      if (statementsStatusFilter)   params.set("status", statementsStatusFilter);
      const res = await fetch(`/api/billing-statements?${params}`, { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const json = await res.json();
        setStatements(json.data || []);
        setStatementsPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load billing statements");
    } finally {
      if (!signal?.aborted) setStatementsLoading(false);
    }
  }, [statementsPage, statementsContractFilter, statementsStatusFilter]);

  // Only fire on the Statements tab — saves a round-trip on first load
  // for users who land on contracts/cash/gst tabs.
  useEffect(() => {
    if (activeTab !== "statements") return;
    statementsControllerRef.current?.abort();
    const controller = new AbortController();
    statementsControllerRef.current = controller;
    fetchStatements(controller.signal);
    return () => controller.abort();
  }, [activeTab, fetchStatements]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleMonthChange = (newYear: number, newMonth: number) => {
    setYear(newYear);
    setMonth(newMonth);
  };

  const handleLockToggle = async () => {
    if (!summary?.period?.id) return;
    const locked = summary.period.status === "locked";
    const action = locked ? "unlock" : "lock";
    setIsLocking(true);
    try {
      const res = await fetch(`/api/accounting/periods/${summary.period.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || `Failed to ${action} period`);
        return;
      }
      toast.success(`Period ${action}ed`);
      fetchData();
    } catch {
      toast.error("Network error");
    } finally {
      setIsLocking(false);
    }
  };

  const handleRecordPayment = async () => {
    if (!recordPaymentStatementId || !rpAmount || Number(rpAmount) <= 0) {
      toast.error("Amount must be positive");
      return;
    }
    setRpSubmitting(true);
    const res = await fetch(`/api/billing-statements/${recordPaymentStatementId}/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Number(rpAmount),
        payment_date: rpDate,
        payment_mode: rpMode,
        payment_reference: rpReference.trim() || undefined,
        notes: rpNotes.trim() || undefined,
      }),
    });
    setRpSubmitting(false);
    if (res.ok) {
      const json = await res.json();
      toast.success(
        `Payment recorded. ${json.payment_status === "paid"
          ? "Invoice fully paid!"
          : `Balance due: ₹${json.balance_due.toLocaleString("en-IN")}`}`
      );
      setRecordPaymentDialogOpen(false);
      setRpAmount(""); setRpReference(""); setRpNotes("");
      fetchStatements();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to record payment");
    }
  };

  const handleFinalizeStatement = async (id: string) => {
    try {
      const res = await fetch(`/api/billing-statements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "finalized" }),
      });
      if (res.ok) { toast.success("Statement finalized"); fetchStatements(); }
      else { const err = await res.json().catch(() => null); toast.error(err?.error || "Failed to finalize"); }
    } catch { toast.error("Failed to finalize statement"); }
  };

  const handleVoidStatement = async () => {
    if (!voidStatementId || !voidReason.trim()) return;
    setVoidSubmitting(true);
    try {
      const res = await fetch(`/api/billing-statements/${voidStatementId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ void_reason: voidReason.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.message || "Statement voided and replacement draft created");
        setVoidDialogOpen(false);
        setVoidStatementId(null);
        setVoidReason("");
        fetchStatements();
      } else {
        toast.error(json.error || "Failed to void statement");
      }
    } catch { toast.error("Failed to void statement"); }
    setVoidSubmitting(false);
  };

  const handleExportStatement = async (id: string) => {
    try {
      const res = await fetch(`/api/billing-statements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "exported" }),
      });
      if (res.ok) { toast.success("Statement exported"); fetchStatements(); }
      else { const err = await res.json().catch(() => null); toast.error(err?.error || "Failed to export"); }
    } catch { toast.error("Failed to export statement"); }
  };

  const handleSendProforma = async (id: string) => {
    const tid = toast.loading("Generating proforma & payment link…");
    try {
      const res = await fetch(`/api/billing-statements/${id}/send-proforma`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (res.ok) {
        toast.dismiss(tid);
        toast.success(json.emailedTo ? `Proforma sent to ${json.emailedTo}` : json.razorpayLinkUrl ? "Proforma generated. No email on file — share the payment link manually." : "Proforma generated");
        fetchStatements();
      } else {
        toast.dismiss(tid);
        toast.error(json.error || "Failed to send proforma");
      }
    } catch { toast.dismiss(tid); toast.error("Failed to send proforma"); }
  };

  const handleGenerateGstInvoice = async (id: string) => {
    const tid = toast.loading("Generating GST invoice…");
    try {
      const res = await fetch(`/api/billing-statements/${id}/generate-gst-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (res.ok) {
        toast.dismiss(tid);
        toast.success(json.emailedTo ? `GST invoice ${json.invoiceNumber} sent to ${json.emailedTo}` : `GST invoice ${json.invoiceNumber} generated`);
        fetchStatements();
      } else {
        toast.dismiss(tid);
        toast.error(json.error || "Failed to generate GST invoice");
      }
    } catch { toast.dismiss(tid); toast.error("Failed to generate GST invoice"); }
  };

  const clearChargesFilters = () => {
    setChargesContractFilter(""); setChargesStatusFilter("");
    setChargesDateFrom(""); setChargesDateTo(""); setChargesPage(1);
  };
  const clearStatementsFilters = () => {
    setStatementsContractFilter(""); setStatementsStatusFilter(""); setStatementsPage(1);
  };

  const hasChargesFilters   = chargesContractFilter || chargesStatusFilter || chargesDateFrom || chargesDateTo;
  const hasStatementsFilters = statementsContractFilter || statementsStatusFilter;
  const isLocked      = summary?.period?.status === "locked";
  const selectedMonth = `${year}-${String(month).padStart(2, "0")}`;
  const pendingHandover = cashHandovers.filter((c) => c.cash_handover_status === "pending_handover");

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IndianRupee className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Billing — Acc Receivables</h1>
          <GuideReopenButton guideKey="billing" label="How it works" />
        </div>
        <MonthPicker year={year} month={month} onChange={handleMonthChange} />
      </div>

      <FinanceGuideCard
        guideKey="billing"
        accentColor="green"
        title="Welcome to Billing 👋"
        subtitle="This is where you manage monthly invoices for all active coworking clients. Invoices are auto-generated on the 28th — your job is to finalize, share, and record payments."
        steps={[
          {
            number: 1,
            title: "Check the month",
            description: "Use the month picker (top right) to switch periods. The current month is selected by default.",
          },
          {
            number: 2,
            title: "Review the statements",
            description: "Each active contract gets one statement per month. The status bar shows how many are draft, finalized, and collected.",
          },
          {
            number: 3,
            title: "Finalize a statement",
            description: "Open a statement row and click Finalize. This locks the amount and makes it ready to share with the client.",
          },
          {
            number: 4,
            title: "Record a payment",
            description: "When the client pays, click 'Record Payment' on the statement row. Enter mode, reference, and date. The balance updates immediately.",
          },
          {
            number: 5,
            title: "Usage charges",
            description: "Extra charges (printing, meeting rooms, etc.) can be added to a draft statement before finalizing — look for 'Add Charge' on the statement row.",
          },
          {
            number: 6,
            title: "Walk-in & cash tabs",
            description: "Day-pass collections, cash handovers, and GST invoice entries are handled in the tabs below the main statement list.",
          },
        ]}
        tip="Statements are auto-generated by the system on the last few days of each month. If a contract is missing, check that it's in 'active' status under Contracts."
      />

      {/* Period status + aging + action banner (when summary loaded) */}
      {!summaryLoading && summary && (
        <>
          <PeriodStatusBar
            period={summary.period}
            totals={summary.totals}
            userRole={userRole}
            onLockToggle={handleLockToggle}
            onExport={() => setShowExport(true)}
            isLocking={isLocking}
          />
          <AgingBuckets buckets={summary.aging_buckets} />
          <ActionRequiredBanner
            contracts={summary.contracts as { contract: { id: string; contract_number: string; title: string; lead?: { first_name: string; last_name: string; company?: string } }; outstanding: number }[]}
            cashHandovers={pendingHandover}
            gstEntries={gstEntries as { contract_id: string; contract_number: string; company: string; total_billable: number; gst_invoice_number: string | null; gst_invoice_sent_at: string | null }[]}
            onSwitchTab={setActiveTab}
          />
        </>
      )}

      {/* ── Section selector (Phase 3) ─────────────────────────────────────
          Three finance-centric buckets above the tab list so the screen
          tells finance "what owes me / what came in / what goes out"
          before forcing them to pick a sub-view.
            • Receivables — Contracts, Proposals, Usage Charges
            • Collections — Walk-in, Cash Handovers
            • Invoicing  — GST Invoices, Statements
      */}
      <div className="flex flex-wrap gap-2 border-b pb-2">
        {([
          { key: "receivables", label: "Receivables", hint: "What customers owe" },
          { key: "collections", label: "Collections", hint: "Cash that came in" },
          { key: "invoicing",   label: "Invoicing",   hint: "Documents going out" },
        ] as const).map((s) => {
          const isActive = section === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => handleSectionChange(s.key)}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors text-left ${
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <div>{s.label}</div>
              <div className={`text-[11px] font-normal mt-0.5 ${isActive ? "text-primary-foreground/80" : "text-muted-foreground/80"}`}>
                {s.hint}
              </div>
            </button>
          );
        })}
      </div>

      {/* Sub-tabs — only the ones inside the active section render. */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-max">
            {section === "receivables" && (
              <>
                <TabsTrigger value="contracts">
                  Contracts{!summaryLoading && summary ? ` (${summary.contracts.length})` : ""}
                </TabsTrigger>
                <TabsTrigger value="proposals">Proposals</TabsTrigger>
                <TabsTrigger value="usage-charges">Usage Charges</TabsTrigger>
              </>
            )}
            {section === "collections" && (
              <>
                <TabsTrigger value="walkin">
                  Walk-in{!summaryLoading && summary ? ` (${summary.walkin_payments.length})` : ""}
                </TabsTrigger>
                <TabsTrigger value="cash">
                  Cash{!summaryLoading ? ` (${pendingHandover.length} pending)` : ""}
                </TabsTrigger>
                <TabsTrigger value="refunds">Refunds</TabsTrigger>
              </>
            )}
            {section === "invoicing" && (
              <>
                <TabsTrigger value="gst">GST Invoices</TabsTrigger>
                <TabsTrigger value="statements">Statements</TabsTrigger>
                <TabsTrigger value="retained-payments">Retained Payments</TabsTrigger>
              </>
            )}
          </TabsList>
        </div>

        {/* ── Contracts ─────────────────────────────────────────────────── */}
        <TabsContent value="contracts" className="space-y-3 mt-4">
          {summaryLoading ? (
            <TableSkeleton />
          ) : !summary ? (
            <EmptyState icon={ScrollText} title="No data" description="Could not load billing data for this period" />
          ) : summary.contracts.length === 0 ? (
            <EmptyState icon={ScrollText} title="No active contracts" description="No contracts are active for this period" />
          ) : (
            summary.contracts.map((cs) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const stmt = (cs as any).billing_statement as { status: string } | null;
              const finalized = stmt?.status === "finalized" || stmt?.status === "exported";
              return (
                <ContractAccountingRow
                  key={cs.contract.id}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  summary={cs as any}
                  accountingPeriodId={summary.period?.id || ""}
                  isLocked={isLocked || false}
                  isStatementFinalized={finalized}
                  periodStart={summary.period_start}
                  onRefresh={fetchData}
                />
              );
            })
          )}
        </TabsContent>

        {/* ── Proposals ─────────────────────────────────────────────────── */}
        <TabsContent value="proposals" className="mt-4">
          <ProposalPaymentsTab month={selectedMonth} />
        </TabsContent>

        {/* ── Walk-in ───────────────────────────────────────────────────── */}
        <TabsContent value="walkin" className="mt-4">
          {summaryLoading ? (
            <TableSkeleton />
          ) : summary ? (
            <WalkinCollectionsTable payments={summary.walkin_payments} />
          ) : null}
        </TabsContent>

        {/* ── Cash Handovers ────────────────────────────────────────────── */}
        <TabsContent value="cash" className="space-y-6 mt-4">
          {summaryLoading ? (
            <TableSkeleton />
          ) : (
            <>
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">Pending Handover</h3>
                <CashHandoverTable
                  items={pendingHandover}
                  status="pending_handover"
                  onRefresh={fetchData}
                />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">Handed Over</h3>
                <CashHandoverTable
                  items={cashHandovers.filter((c) => c.cash_handover_status === "handed_over")}
                  status="handed_over"
                  onRefresh={fetchData}
                />
              </div>
            </>
          )}
        </TabsContent>

        {/* ── Refunds (under Collections) ───────────────────────────────── */}
        <TabsContent value="refunds" className="space-y-4 mt-4">
          <RefundsTab />
        </TabsContent>

        {/* ── GST Invoices ──────────────────────────────────────────────── */}
        <TabsContent value="gst" className="mt-4">
          {summaryLoading ? (
            <TableSkeleton />
          ) : (
            <GstInvoiceEntry entries={gstEntries} onRefresh={fetchData} />
          )}
        </TabsContent>

        {/* ── Retained Payments (under Invoicing) ───────────────────────── */}
        <TabsContent value="retained-payments" className="space-y-4 mt-4">
          <RetainedPaymentsTab />
        </TabsContent>

        {/* ── Usage Charges ─────────────────────────────────────────────── */}
        <TabsContent value="usage-charges" className="space-y-4 mt-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={chargesContractFilter}
                onValueChange={(val) => { setChargesContractFilter(val === "all" ? "" : val); setChargesPage(1); }}
              >
                <SelectTrigger className="w-[200px]"><SelectValue placeholder="All Contracts" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Contracts</SelectItem>
                  {contractFilters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.contract_number}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={chargesStatusFilter}
                onValueChange={(val) => { setChargesStatusFilter(val === "all" ? "" : val); setChargesPage(1); }}
              >
                <SelectTrigger className="w-[140px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.entries(USAGE_STATUS_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={chargesDateFrom}
                onChange={(e) => { setChargesDateFrom(e.target.value); setChargesPage(1); }}
                className="w-[150px]"
                placeholder="From"
              />
              <Input
                type="date"
                value={chargesDateTo}
                onChange={(e) => { setChargesDateTo(e.target.value); setChargesPage(1); }}
                className="w-[150px]"
                placeholder="To"
              />
              {hasChargesFilters && (
                <Button variant="ghost" size="sm" onClick={clearChargesFilters}>
                  <X className="mr-1 h-4 w-4" />Clear
                </Button>
              )}
            </div>
            <Button onClick={() => setAddChargeOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />Add Charge
            </Button>
          </div>

          {chargesLoading ? (
            <TableSkeleton rows={6} />
          ) : charges.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No usage charges found"
              description={hasChargesFilters ? "Try adjusting your filters." : "Add your first usage charge to get started."}
              actionLabel={!hasChargesFilters ? "Add Charge" : undefined}
              onAction={!hasChargesFilters ? () => setAddChargeOpen(true) : undefined}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Description</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Reference</th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Qty</th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Unit Price</th>
                    <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Subtotal</th>
                    <th className="px-4 py-3 text-right font-medium hidden md:table-cell">GST</th>
                    <th className="px-4 py-3 text-right font-medium">Total (incl. GST)</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Charge Date</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Billing Period</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {charges.map((charge) => (
                    <tr key={charge.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium max-w-[200px] truncate">{charge.description}</td>
                      <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">
                        {/* Show both contract + booking when present (a posted-
                            to-bill booking has both). Each is clickable —
                            opens detail in a new tab so finance keeps context. */}
                        <div className="flex flex-col gap-0.5">
                          {charge.contract?.contract_number && (
                            <Link
                              href={`/contracts/${charge.contract_id}`}
                              target="_blank"
                              rel="noopener"
                              className="text-primary hover:underline"
                              title="Open contract"
                            >{charge.contract.contract_number}</Link>
                          )}
                          {charge.booking?.booking_number && (
                            <Link
                              href={`/bookings/${charge.booking_id}`}
                              target="_blank"
                              rel="noopener"
                              className="text-blue-600 hover:underline"
                              title={`Open booking — ${formatDate(charge.booking.booking_date)}`}
                            >{charge.booking.booking_number}</Link>
                          )}
                          {!charge.contract?.contract_number && !charge.booking?.booking_number && "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">{charge.quantity}</td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">{formatCurrency(charge.unit_price)}</td>
                      <td className="px-4 py-3 text-right hidden md:table-cell text-muted-foreground">{formatCurrency(charge.total)}</td>
                      <td className="px-4 py-3 text-right hidden md:table-cell text-xs text-muted-foreground">
                        {charge.gst_rate ? `${formatCurrency(charge.gst_amount || 0)} (${charge.gst_rate}%)` : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold">
                        {formatCurrency(charge.total_with_gst ?? charge.total)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{formatDate(charge.charge_date)}</td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {(() => {
                          const d = new Date(charge.charge_date + "T00:00:00");
                          const monthLabel = d.toLocaleString("en-IN", { month: "short", year: "numeric" });
                          const cycleLabels: Record<string, string> = { monthly: "Monthly", quarterly: "Quarterly", half_yearly: "Half-Yearly", yearly: "Yearly" };
                          const cycle = charge.contract?.billing_cycle;
                          return (
                            <div>
                              <span className="text-sm font-medium">{monthLabel}</span>
                              {cycle && <span className="block text-xs text-muted-foreground">{cycleLabels[cycle] || cycle}</span>}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className={USAGE_STATUS_COLORS[charge.status] || ""}>
                          {USAGE_STATUS_LABELS[charge.status] || charge.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem><Eye className="mr-2 h-4 w-4" />View Details</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {chargesPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {chargesPagination.page} of {chargesPagination.totalPages} ({chargesPagination.total} total)
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={chargesPage <= 1} onClick={() => setChargesPage(chargesPage - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={chargesPage >= chargesPagination.totalPages} onClick={() => setChargesPage(chargesPage + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── Billing Statements ────────────────────────────────────────── */}
        <TabsContent value="statements" className="space-y-4 mt-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={statementsContractFilter}
                onValueChange={(val) => { setStatementsContractFilter(val === "all" ? "" : val); setStatementsPage(1); }}
              >
                <SelectTrigger className="w-[200px]"><SelectValue placeholder="All Contracts" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Contracts</SelectItem>
                  {contractFilters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.contract_number}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={statementsStatusFilter}
                onValueChange={(val) => { setStatementsStatusFilter(val === "all" ? "" : val); setStatementsPage(1); }}
              >
                <SelectTrigger className="w-[140px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.entries(STATEMENT_STATUS_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {hasStatementsFilters && (
                <Button variant="ghost" size="sm" onClick={clearStatementsFilters}>
                  <X className="mr-1 h-4 w-4" />Clear
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleGenerateMissingBills} disabled={generatingMissing}>
                {generatingMissing ? (
                  <><span className="mr-2 h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin inline-block" />Generating…</>
                ) : (
                  <><RefreshCcw className="mr-2 h-4 w-4" />Generate Missing Bills</>
                )}
              </Button>
              <Button onClick={() => setGenerateStatementOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />Generate Statement
              </Button>
            </div>
          </div>

          {statementsLoading ? (
            <TableSkeleton rows={6} />
          ) : statements.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No billing statements found"
              description={hasStatementsFilters ? "Try adjusting your filters." : "Generate your first billing statement to get started."}
              actionLabel={!hasStatementsFilters ? "Generate Statement" : undefined}
              onAction={!hasStatementsFilters ? () => setGenerateStatementOpen(true) : undefined}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Statement #</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Reference</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Lead</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Period</th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Fixed</th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Usage</th>
                    <th className="px-4 py-3 text-right font-medium">Total</th>
                    <th className="px-4 py-3 text-left font-medium">Lifecycle</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {statements.map((stmt) => (
                    <tr key={stmt.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs">{stmt.statement_number}</td>
                      <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">
                        {stmt.contract?.contract_number || stmt.booking?.booking_number || "—"}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {stmt.lead
                          ? stmt.lead.company || `${stmt.lead.first_name} ${stmt.lead.last_name}`
                          : stmt.booking?.guest_name || "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                        {formatDate(stmt.period_start)} – {formatDate(stmt.period_end)}
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">{formatCurrency(stmt.fixed_amount)}</td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">{formatCurrency(stmt.usage_amount)}</td>
                      <td className="px-4 py-3 text-right font-medium">{formatCurrency(stmt.total_amount)}</td>
                      <td className="px-4 py-3">
                        <BillingLifecycleStatus
                          status={stmt.status}
                          emailed_at={stmt.emailed_at}
                          razorpay_payment_link_url={stmt.razorpay_payment_link_url}
                          payment_status={stmt.payment_status}
                          accounted={stmt.accounted}
                          finalized_at={stmt.finalized_at}
                          gst_invoice_number={stmt.gst_invoice_number}
                          proforma_sent_at={stmt.proforma_sent_at}
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setViewStatementId(stmt.id)}>
                              <Eye className="mr-2 h-4 w-4" />View Detail
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled>
                              <Download className="mr-2 h-4 w-4" />Download PDF
                            </DropdownMenuItem>
                            {stmt.status === "draft" && (
                              <DropdownMenuItem onClick={() => handleFinalizeStatement(stmt.id)}>
                                <CheckCircle className="mr-2 h-4 w-4" />Finalize
                              </DropdownMenuItem>
                            )}
                            {(stmt.status === "finalized" || stmt.status === "exported") && !stmt.proforma_sent_at && !stmt.gst_invoice_number && (
                              <DropdownMenuItem onClick={() => handleSendProforma(stmt.id)}>
                                <Send className="mr-2 h-4 w-4" />Send Proforma + Payment Link
                              </DropdownMenuItem>
                            )}
                            {stmt.status === "finalized" && stmt.proforma_sent_at && !stmt.gst_invoice_number && (
                              <DropdownMenuItem onClick={() => handleSendProforma(stmt.id)}>
                                <Send className="mr-2 h-4 w-4" />Resend Proforma
                              </DropdownMenuItem>
                            )}
                            {(stmt.status === "finalized" || stmt.status === "exported") && !stmt.gst_invoice_number && (stmt.payment_status === "paid" || stmt.payment_status === "partially_paid") && (
                              <DropdownMenuItem onClick={() => handleGenerateGstInvoice(stmt.id)}>
                                <FileCheck className="mr-2 h-4 w-4" />Generate & Send GST Invoice
                              </DropdownMenuItem>
                            )}
                            {stmt.status === "finalized" && (
                              <DropdownMenuItem
                                onClick={() => {
                                  setRecordPaymentStatementId(stmt.id);
                                  setRecordPaymentDialogOpen(true);
                                }}
                              >
                                <IndianRupee className="mr-2 h-4 w-4" />Record Offline Payment
                              </DropdownMenuItem>
                            )}
                            {(stmt.status === "finalized" || stmt.status === "exported") && userRole === "admin" && (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => {
                                  setVoidStatementId(stmt.id);
                                  setVoidReason("");
                                  setVoidDialogOpen(true);
                                }}
                              >
                                <X className="mr-2 h-4 w-4" />Void & Re-issue
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {statementsPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {statementsPagination.page} of {statementsPagination.totalPages} ({statementsPagination.total} total)
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={statementsPage <= 1} onClick={() => setStatementsPage(statementsPage - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={statementsPage >= statementsPagination.totalPages} onClick={() => setStatementsPage(statementsPage + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      <ExportSummaryDialog open={showExport} onOpenChange={setShowExport} year={year} month={month} />
      <AddUsageChargeDialog open={addChargeOpen} onOpenChange={setAddChargeOpen} onSuccess={fetchCharges} />
      <GenerateStatementDialog open={generateStatementOpen} onOpenChange={setGenerateStatementOpen} onSuccess={fetchStatements} />
      <ViewStatementDialog
        statementId={viewStatementId}
        open={!!viewStatementId}
        onOpenChange={(v) => { if (!v) setViewStatementId(null); }}
        onStatusChange={fetchStatements}
        userRole={userRole}
      />

      <Dialog open={recordPaymentDialogOpen} onOpenChange={setRecordPaymentDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Amount (₹)</Label>
                <Input type="number" value={rpAmount} onChange={(e) => setRpAmount(e.target.value)} placeholder="e.g. 15000" />
              </div>
              <div className="space-y-2">
                <Label>Payment Date</Label>
                <Input type="date" value={rpDate} onChange={(e) => setRpDate(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Mode</Label>
                <Select value={rpMode} onValueChange={setRpMode}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="neft">NEFT</SelectItem>
                    <SelectItem value="rtgs">RTGS</SelectItem>
                    <SelectItem value="upi">UPI</SelectItem>
                    <SelectItem value="cheque">Cheque</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="razorpay">Razorpay</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Reference / UTR No.</Label>
                <Input value={rpReference} onChange={(e) => setRpReference(e.target.value)} placeholder="UTR or cheque number" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea value={rpNotes} onChange={(e) => setRpNotes(e.target.value)} placeholder="Additional notes…" rows={2} />
            </div>
            <Button onClick={handleRecordPayment} disabled={rpSubmitting} className="w-full">
              {rpSubmitting ? "Recording…" : "Record Payment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Void Statement Dialog */}
      <Dialog open={voidDialogOpen} onOpenChange={setVoidDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <X className="h-5 w-5" />
              Void & Re-issue Statement
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              <p className="font-medium mb-1">This will:</p>
              <ul className="list-disc pl-4 space-y-0.5 text-xs">
                <li>Mark the current statement as <strong>voided</strong></li>
                <li>Un-link all usage charges so they can be re-billed</li>
                <li>Create a new <strong>draft</strong> statement with the same billing data</li>
              </ul>
              <p className="mt-2 text-xs">Blocked if any payments have been recorded against this statement.</p>
            </div>
            <div className="space-y-2">
              <Label>Reason for voiding *</Label>
              <Textarea
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="e.g., Wrong charges included, incorrect tax rate, duplicate invoice…"
                rows={3}
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setVoidDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                disabled={voidSubmitting || !voidReason.trim()}
                onClick={handleVoidStatement}
              >
                {voidSubmitting ? "Voiding…" : "Void & Create Draft"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

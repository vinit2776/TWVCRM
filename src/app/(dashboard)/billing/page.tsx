"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  Receipt,
  MoreHorizontal,
  Pencil,
  Eye,
  Download,
  CheckCircle,
  X,
  IndianRupee,
  ScrollText,
  Send,
  FileCheck,
  Printer,
  Building2,
  Search,
  Ban,
  MinusCircle,
  PauseCircle,
  PlayCircle,
  Loader2,
} from "lucide-react";
import { USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS } from "@/lib/constants";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AddUsageChargeDialog } from "@/components/billing/add-usage-charge-dialog";
import { EditUsageChargeDialog } from "@/components/billing/edit-usage-charge-dialog";
import { UsageChargeDetailsDialog } from "@/components/billing/usage-charge-details-dialog";
import { ManualPrintEntryDialog } from "@/components/accounting/manual-print-entry-dialog";
import { LogFacilityUsageDialog } from "@/components/accounting/log-facility-usage-dialog";
import { GenerateStatementDialog } from "@/components/billing/generate-statement-dialog";
const ViewStatementDialog = dynamic(
  () => import("@/components/billing/view-statement-dialog").then(m => ({ default: m.ViewStatementDialog })),
  { ssr: false }
);
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";
import { formatDate, formatCurrency } from "@/lib/utils";
import { computeSettlement } from "@/lib/settlement";
import { RecordPaymentDialog } from "@/components/billing/record-payment-dialog";
import { toast } from "sonner";
import { MonthPicker } from "@/components/accounting/month-picker";
import { UsageBillingBoard, type BoardCharge } from "@/components/billing/usage-billing-board";
import type { UsageContractGroup } from "@/lib/usage-billing";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { PeriodStatusBar } from "@/components/accounting/period-status-bar";
import { AgingBuckets } from "@/components/accounting/aging-buckets";
import { ContractAccountingRow } from "@/components/accounting/contract-accounting-row";
import { FinanceGuideCard, GuideReopenButton } from "@/components/finance/finance-guide-card";
import { BillingPipelineBar } from "@/components/billing/billing-pipeline-bar";
import { ProformaBillingCard } from "@/components/billing/proforma-billing-card";
import { UnbilledBilledTabs } from "@/components/billing/unbilled-billed-tabs";
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
const ElectricityBillsTab    = dynamic(() => import("@/components/billing/electricity-bills-tab").then(m => m.ElectricityBillsTab),             { ssr: false, loading: () => <TabLoading label="Electricity" /> });

function TabLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
      <span className="h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
      Loading {label}…
    </div>
  );
}

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
const USAGE_SOURCE_COLORS: Record<string, string> = {
  manual:   "bg-slate-50 text-slate-700 border-slate-300",
  print:    "bg-blue-50 text-blue-800 border-blue-200",
  facility: "bg-purple-50 text-purple-800 border-purple-200",
};
const USAGE_SOURCE_LABELS: Record<string, string> = {
  manual:   "Manual charge",
  print:    "Print log",
  facility: "Facility usage",
};

// "Bills in: [month] [status]" tag — which billing cycle a charge belongs to,
// and whether that cycle has already picked it up. See billingCycleOf() in
// /api/usage-charges for how this is derived.
const BILLING_CYCLE_TAG: Record<string, { text: string; className: string }> = {
  cycle_open:          { text: "cycle still open",      className: "bg-slate-50 text-slate-600 border-slate-200" },
  ready:               { text: "ready",                 className: "bg-blue-50 text-blue-800 border-blue-200" },
  overdue:             { text: "⚠ overdue, never billed", className: "bg-red-50 text-red-700 border-red-200" },
  billed:              { text: "billed",                className: "bg-green-50 text-green-700 border-green-200" },
  waived:              { text: "waived",                className: "bg-gray-50 text-gray-600 border-gray-200" },
  supplemental_needed: { text: "supplemental needed",   className: "bg-purple-50 text-purple-700 border-purple-200" },
};

/** Company name if set, else the contact's full name, else "—" — same
 *  fallback order unbilled-queue.ts's customerNameOf uses, so a charge's
 *  customer reads the same way here as it does in the Unbilled queue. */
function customerNameOf(lead?: { first_name?: string; last_name?: string; company?: string } | null): string {
  if (!lead) return "—";
  return lead.company || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "—";
}

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
  // Present on every row returned by /api/usage-charges — it merges three
  // tables (ad-hoc charges, print-quota entries, facility entries) into this
  // shape. "manual" rows are the only ones Edit applies to; billable is only
  // a meaningful yes/no distinction for print/facility (null = n/a, since a
  // manual charge is always billable unless waived, which status already shows).
  source?: "manual" | "print" | "facility";
  billable?: boolean | null;
  billing_cycle_status?: "cycle_open" | "ready" | "overdue" | "billed" | "waived" | "supplemental_needed";
  billing_cycle_label?: string;
  // Manual rows only — non-null excludes this charge from the next Generate
  // Drafts sweep without changing `status`, which stays "pending" throughout.
  held_at?: string | null;
  hold_reason?: string | null;
  waive_reason?: string | null;
  waived_at?: string | null;
  waived_by_name?: string | null;
  /** Set by "Bill anyway" on a stale charge — see USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS. */
  reviewed_at?: string | null;
}

interface BillingStatement {
  id: string;
  statement_number: string;
  contract_id?: string | null;
  booking_id?: string | null;
  contract?: { contract_number: string } | null;
  booking?: { booking_number: string; booking_date: string; guest_name?: string } | null;
  lead_id?: string | null;
  lead?: { id?: string; first_name: string; last_name: string; company?: string; email?: string | null; phone?: string | null; mobile?: string | null } | null;
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
  // Auto-proforma split
  statement_type?: 'combined' | 'rent' | 'usage' | null;
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
    total_amount: number;
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
  billing_statement?: {
    id: string;
    status: string;
    statement_number: string;
    total_amount?: number | null;
    fixed_amount?: number | null;
    usage_amount?: number | null;
    booking_usage_amount?: number | null;
    finalized_at?: string | null;
    proforma_sent_at?: string | null;
    gst_invoice_number?: string | null;
    payment_status?: string | null;
    accounted?: boolean | null;
    accounted_at?: string | null;
    razorpay_payment_link_url?: string | null;
    emailed_at?: string | null;
    /** Actor names from joined users table */
    finalized_by_user?: { full_name: string } | null;
    proforma_sent_by_user?: { full_name: string } | null;
    gst_generated_by_user?: { full_name: string } | null;
    accounted_by_user?: { full_name: string } | null;
    /** Statement-level payments (billing_payments table) */
    billing_payments?: Array<{
      id: string;
      amount: number;
      payment_date: string;
      payment_mode: string;
      payment_reference?: string | null;
      razorpay_payment_id?: string | null;
      recorded_by_user?: { full_name: string } | null;
    }> | null;
  } | null;
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
  billing_statement_id: string | null;
  billing_statement_status: string | null;
  gst_source: "statement" | "payment" | null;
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
  const [pipeline, setPipeline]           = useState<{ counts: Record<string, number>; amounts: Record<string, number>; total: number } | null>(null);

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("tab") ?? "rentals";
      // Legacy redirects: "contracts" was merged into "statements" (2026),
      // which itself later split back into "rentals" / "usage" — a link
      // built for either era (including the ?tab=statements&type=usage
      // deep link the billing-run email sends) still lands somewhere sane.
      if (tab === "contracts") return "rentals";
      if (tab === "statements") return params.get("type") === "usage" ? "usage" : "rentals";
      return tab;
    }
    return "rentals";
  });

  // ── Section grouping (Phase 3 finance consolidation) ─────────────────────
  // Three finance-centric buckets. "contracts" merged into "statements" (Invoicing),
  // which itself later split into "rentals" and "usage" once usage needed its own
  // discovery/generate flow instead of sharing one mixed view.
  const SECTION_TABS = {
    // Order matters here beyond membership: handleSectionChange lands on
    // index [0] when switching into a section, so the two visible tabs come
    // first — "proposals" stays reachable by deep link (sectionForTab still
    // maps it here) but is no longer a landing tab or a visible trigger.
    receivables: ["usage-charges", "usage", "proposals"],
    collections: ["walkin", "cash", "refunds"],
    invoicing:   ["rentals", "gst", "retained-payments", "electricity"],
  } as const;
  type Section = keyof typeof SECTION_TABS;
  const sectionForTab = (tab: string): Section => {
    // Legacy: "contracts" and "statements" both live under invoicing now.
    if (tab === "contracts" || tab === "statements") return "invoicing";
    for (const s of Object.keys(SECTION_TABS) as Section[]) {
      if ((SECTION_TABS[s] as readonly string[]).includes(tab)) return s;
    }
    return "invoicing";
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
  // Unbilled is the working view — always status=pending, no status picker
  // (there's nothing to choose). History is the reference view for what's
  // already resolved; chargesStatusFilter there narrows within it
  // (""=Billed+Waived combined, or a single status) but can never include
  // pending — that's what makes it "history" rather than a second copy of
  // Unbilled.
  const [chargesView, setChargesView]                 = useState<"unbilled" | "history">("unbilled");
  const [chargesStatusFilter, setChargesStatusFilter] = useState("");
  const [chargesDateFrom, setChargesDateFrom]         = useState("");
  const [chargesDateTo, setChargesDateTo]             = useState("");
  const [chargesSearchQuery, setChargesSearchQuery]   = useState("");
  const [addChargeOpen, setAddChargeOpen]             = useState(false);
  const [addChargeContractId, setAddChargeContractId] = useState<string | undefined>(undefined);
  const [editChargeOpen, setEditChargeOpen]           = useState(false);
  const [editingCharge, setEditingCharge]             = useState<UsageCharge | null>(null);
  const [viewChargeOpen, setViewChargeOpen]           = useState(false);
  const [viewingCharge, setViewingCharge]             = useState<UsageCharge | null>(null);
  const [printEntryOpen, setPrintEntryOpen]           = useState(false);
  const [facilityUsageOpen, setFacilityUsageOpen]     = useState(false);

  // ── Per-charge review actions: waive fully, reduce (waive partly), hold ──
  const [waiveChargeTarget, setWaiveChargeTarget]       = useState<UsageCharge | null>(null);
  const [waiveChargeReason, setWaiveChargeReason]       = useState("");
  const [waiveChargeReasonError, setWaiveChargeReasonError] = useState(false);
  const [waiveChargeSubmitting, setWaiveChargeSubmitting]   = useState(false);

  const [reduceChargeTarget, setReduceChargeTarget]     = useState<UsageCharge | null>(null);
  const [reduceChargeAmount, setReduceChargeAmount]     = useState("");
  const [reduceChargeReason, setReduceChargeReason]     = useState("");
  const [reduceChargeError, setReduceChargeError]       = useState<string | null>(null);
  const [reduceChargeSubmitting, setReduceChargeSubmitting] = useState(false);

  const [holdChargeTarget, setHoldChargeTarget]         = useState<UsageCharge | null>(null);
  const [holdChargeReason, setHoldChargeReason]         = useState("");
  const [holdChargeReasonError, setHoldChargeReasonError]   = useState(false);
  const [holdChargeSubmitting, setHoldChargeSubmitting]     = useState(false);

  // Manual charges live on usage_charges; print/facility are separate
  // tables with their own PATCH endpoints — same action verbs, different URL.
  const usageChargeEndpoint = (charge: UsageCharge) =>
    charge.source === "print"    ? `/api/accounting/print-usage/${charge.id}` :
    charge.source === "facility" ? `/api/accounting/facility-usage/${charge.id}` :
    `/api/usage-charges/${charge.id}`;

  // A pending charge past this many days needs an explicit "Bill anyway"
  // (or Waive / Hold) before it can reach an invoice — see
  // USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS's own doc comment.
  const isChargeStale = (charge: UsageCharge) => {
    if (charge.reviewed_at) return false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS);
    return charge.charge_date < cutoff.toISOString().slice(0, 10);
  };

  // Replaces the "Bills in: [month] · [cycle state]" tag on the Unbilled
  // view with a plain age — the cycle-status vocabulary (cycle_open / ready
  // / overdue / supplemental_needed) is implementation detail now that
  // generateUsageStatements sweeps anything outstanding regardless of month
  // (see the usage-billing-engine PR); all that actually matters to someone
  // reviewing this list is "how long has this been sitting here."
  const chargeAgeLabel = (charge: UsageCharge): { text: string; className: string } => {
    const days = Math.floor((Date.now() - new Date(charge.charge_date + "T00:00:00").getTime()) / 86400000);
    const text = days <= 0 ? "Today" : days === 1 ? "1 day ago" : `${days} days ago`;
    const className = days > USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS ? "text-red-600 font-medium"
      : days > 30 ? "text-amber-600"
      : "text-muted-foreground";
    return { text, className };
  };

  const submitWaiveCharge = async () => {
    if (!waiveChargeTarget) return;
    if (!waiveChargeReason.trim()) { setWaiveChargeReasonError(true); return; }
    setWaiveChargeSubmitting(true);
    try {
      const body = waiveChargeTarget.source === "print" || waiveChargeTarget.source === "facility"
        ? { waive: true, waive_reason: waiveChargeReason.trim() }
        : { status: "waived", waive_reason: waiveChargeReason.trim() };
      const res = await fetch(usageChargeEndpoint(waiveChargeTarget), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("Charge waived");
        setWaiveChargeTarget(null);
        setWaiveChargeReason("");
        setWaiveChargeReasonError(false);
        refreshCharges();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to waive charge");
      }
    } finally {
      setWaiveChargeSubmitting(false);
    }
  };

  const submitReduceCharge = async () => {
    if (!reduceChargeTarget) return;
    const newTotal = Number(reduceChargeAmount);
    if (!reduceChargeAmount || Number.isNaN(newTotal) || newTotal < 0) {
      setReduceChargeError("Enter a valid amount.");
      return;
    }
    if (newTotal >= reduceChargeTarget.total) {
      setReduceChargeError(`Enter an amount less than the current total (${formatCurrency(reduceChargeTarget.total)}).`);
      return;
    }
    if (!reduceChargeReason.trim()) {
      setReduceChargeError("Enter a reason for the reduction.");
      return;
    }
    setReduceChargeSubmitting(true);
    try {
      // Field name differs per source: manual keeps Qty x Unit Price = Total
      // exact (see the CREATE route's own doc comment on why); print/facility
      // have a single billed amount to override instead.
      const body: Record<string, unknown> = { reduction_reason: reduceChargeReason.trim() };
      if (reduceChargeTarget.source === "print") {
        body.amount = newTotal;
      } else if (reduceChargeTarget.source === "facility") {
        body.total_charge = newTotal;
      } else {
        body.total = newTotal;
        body.unit_price = reduceChargeTarget.quantity
          ? parseFloat((newTotal / reduceChargeTarget.quantity).toFixed(2))
          : newTotal;
      }
      const res = await fetch(usageChargeEndpoint(reduceChargeTarget), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("Charge amount reduced");
        setReduceChargeTarget(null);
        setReduceChargeAmount("");
        setReduceChargeReason("");
        setReduceChargeError(null);
        refreshCharges();
      } else {
        const err = await res.json().catch(() => null);
        setReduceChargeError(err?.error || "Failed to reduce charge");
      }
    } finally {
      setReduceChargeSubmitting(false);
    }
  };

  const submitHoldCharge = async () => {
    if (!holdChargeTarget) return;
    if (!holdChargeReason.trim()) { setHoldChargeReasonError(true); return; }
    setHoldChargeSubmitting(true);
    try {
      const res = await fetch(usageChargeEndpoint(holdChargeTarget), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hold: true, hold_reason: holdChargeReason.trim() }),
      });
      if (res.ok) {
        toast.success("Charge held — it won't be billed until released");
        setHoldChargeTarget(null);
        setHoldChargeReason("");
        setHoldChargeReasonError(false);
        refreshCharges();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to hold charge");
      }
    } finally {
      setHoldChargeSubmitting(false);
    }
  };

  const releaseChargeHold = async (charge: UsageCharge) => {
    try {
      const res = await fetch(usageChargeEndpoint(charge), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hold: false }),
      });
      if (res.ok) {
        toast.success("Hold released");
        refreshCharges();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to release hold");
      }
    } catch {
      toast.error("Failed to release hold");
    }
  };

  const submitReviewCharge = async (charge: UsageCharge) => {
    try {
      const res = await fetch(usageChargeEndpoint(charge), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review: true }),
      });
      if (res.ok) {
        toast.success("Reviewed — it's now included in its month's invoice");
        refreshCharges();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to mark as reviewed");
      }
    } catch {
      toast.error("Failed to mark as reviewed");
    }
  };

  // The grouped board's charges → the UsageCharge shape the existing
  // waive / reduce / hold / release / review dialogs already work with.
  const boardToUsageCharge = (c: BoardCharge, g: UsageContractGroup): UsageCharge => ({
    id: c.id,
    source: c.source,
    description: c.description,
    quantity: c.quantity,
    unit_price: c.unitPrice,
    total: c.amount,
    charge_date: c.date,
    status: "pending",
    held_at: c.held ? "held" : null,
    hold_reason: c.holdReason,
    reviewed_at: c.reviewed ? "reviewed" : null,
    contract_id: g.contractId,
    contract: { id: g.contractId, contract_number: g.contractNumber },
  } as UsageCharge);

  const openEditManualCharge = async (chargeId: string) => {
    const res = await fetch(`/api/usage-charges/${chargeId}`);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.data) { toast.error(json?.error || "Couldn't load the charge"); return; }
    setEditingCharge(json.data as UsageCharge);
    setEditChargeOpen(true);
  };

  // ── Billing Statements ────────────────────────────────────────────────────
  const [statements, setStatements]                       = useState<BillingStatement[]>([]);
  const [statementsLoading, setStatementsLoading]         = useState(true);
  const [statementsPage, setStatementsPage]               = useState(1);
  const [generateStatementOpen, setGenerateStatementOpen] = useState(false);

  // Manual monthly billing — handled by <ProformaBillingCard /> per-mode. Cards
  // own their own preview/run state; the page only computes the period labels.

  // Refresh statements + monthly summary after a successful run from any card
  const refreshAfterRun = async () => { await fetchStatements(); await fetchData(); };

  // Deep-link support (e.g. the Billing Reconciliation report links straight to
  // an invoice): ?statement=<id> opens the dialog. A lazy useState initializer
  // alone only fires on a hard reload — Next's router reuses this page's
  // already-mounted instance on a client-side <Link> navigation from another
  // route, so the initializer never re-runs and the dialog silently fails to
  // open. usePathname() IS reactive across that navigation (its return value
  // updates on the reused instance), so re-reading the query string whenever
  // it changes catches the soft-navigation case too.
  const [viewStatementId, setViewStatementId]             = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("statement");
    }
    return null;
  });
  const pathname = usePathname();
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get("statement");
    if (sid) setViewStatementId(sid);
  }, [pathname]);

  // ── Record Payment dialog (form lives in RecordPaymentDialog) ────────────
  const [recordPaymentDialogOpen, setRecordPaymentDialogOpen]   = useState(false);
  const [recordPaymentStatementId, setRecordPaymentStatementId] = useState<string | null>(null);
  const [recordPaymentBalance, setRecordPaymentBalance]         = useState<number | null>(null);

  // ── Contract list for filter dropdowns ───────────────────────────────────
  const [contractFilters, setContractFilters] = useState<ContractFilter[]>([]);


  // ── Get user role ────────────────────────────────────────────────────────
  // Via /api/me (server-to-server) rather than a browser→supabase.co query:
  // when that direct call is blocked, userRole stayed null and silently hid
  // every role-gated control on this page (Print/Facility usage, Send, …).
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((j: { role: string | null }) => { setUserRole(j.role || "sales_rep"); })
      .catch(() => toast.error("Couldn't load your role — some actions may be hidden. Refresh to retry."));
  }, []);

  // ── Fetch monthly summary (with AbortController for cleanup) ─────────────
  const summaryControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setSummaryLoading(true);
    try {
      const [summaryRes, cashRes, gstRes, pipelineRes] = await Promise.all([
        fetch(`/api/accounting/monthly-summary?year=${year}&month=${month}`, { signal }),
        fetch(`/api/accounting/cash-handovers?year=${year}&month=${month}`, { signal }),
        fetch(`/api/accounting/gst-invoices?year=${year}&month=${month}`, { signal }),
        fetch(`/api/billing-statements/pipeline?year=${year}&month=${month}`, { signal }),
      ]);
      if (signal?.aborted) return;
      if (summaryRes.ok)  setSummary((await summaryRes.json()).data);
      if (cashRes.ok)     setCashHandovers((await cashRes.json()).data || []);
      if (gstRes.ok)      setGstEntries((await gstRes.json()).data || []);
      if (pipelineRes.ok) setPipeline((await pipelineRes.json()).data);
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

  // The grouped Unbilled board loads its own data; bump this after any charge
  // mutation so it refetches alongside the History table.
  const [boardRefreshKey, setBoardRefreshKey] = useState(0);
  const refreshCharges = useCallback(() => {
    void fetchChargesRef.current?.();
    setBoardRefreshKey((k) => k + 1);
  }, []);
  const fetchChargesRef = useRef<(() => Promise<void>) | null>(null);

  const fetchCharges = useCallback(async (signal?: AbortSignal) => {
    setChargesLoading(true);
    try {
      const params = new URLSearchParams({ page: String(chargesPage), limit: "25" });
      if (chargesContractFilter) params.set("contract_id", chargesContractFilter);
      // Unbilled is always exactly "pending". History is anything but —
      // narrowed to one status if chosen, otherwise both non-pending
      // statuses combined (see the comma-separated `status` support in
      // GET /api/usage-charges).
      params.set("status", chargesView === "unbilled" ? "pending" : (chargesStatusFilter || "billed,waived"));
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
  }, [chargesPage, chargesContractFilter, chargesView, chargesStatusFilter, chargesDateFrom, chargesDateTo]);
  useEffect(() => { fetchChargesRef.current = () => fetchCharges(); }, [fetchCharges]);

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
      // Fetch all statements once. Both downstream sections — Booking Statements
      // and Proforma Statements — filter client-side. This lets the rent/usage
      // chips display accurate counts (e.g., "Usage (3)" even while "Rent" is
      // selected) without a refetch on every chip click.
      const params = new URLSearchParams({ page: String(statementsPage), limit: "100" });
      const res = await fetch(`/api/billing-statements?${params}`, { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const json = await res.json();
        setStatements(json.data || []);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load billing statements");
    } finally {
      if (!signal?.aborted) setStatementsLoading(false);
    }
  }, [statementsPage]);

  // Only fire on the Rentals/Usage tabs (the old combined "Statements" tab,
  // now split in two) — saves a round-trip on first load for users who land
  // on contracts/cash/gst tabs.
  useEffect(() => {
    if (activeTab !== "rentals" && activeTab !== "usage") return;
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

  const handleFinalizeStatement = async (id: string) => {
    try {
      const res = await fetch(`/api/billing-statements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "finalized" }),
      });
      if (res.ok) { toast.success("Statement finalized"); fetchStatements(); fetchData(); }
      else { const err = await res.json().catch(() => null); toast.error(err?.error || "Failed to finalize"); }
    } catch { toast.error("Failed to finalize statement"); }
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
        if (json.emailedTo) {
          toast.success(`Proforma sent to ${json.emailedTo}`);
        } else if (json.razorpayLinkUrl) {
          toast.warning("Proforma generated — no email on file. Share the payment link manually with the client.");
        } else {
          toast.warning("Proforma recorded but no email was sent and no payment link was created. Add a client email or enable Razorpay to complete this step.");
        }
        fetchStatements();
        fetchData();
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
        fetchData();
      } else {
        toast.dismiss(tid);
        toast.error(json.error || "Failed to generate GST invoice");
      }
    } catch { toast.dismiss(tid); toast.error("Failed to generate GST invoice"); }
  };

  const handleMarkAccounted = async (id: string) => {
    try {
      const res = await fetch(`/api/billing-statements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounted: true }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success("Statement marked as accounted");
        fetchStatements();
        fetchData();
      } else {
        toast.error(json.error || "Failed to mark as accounted");
      }
    } catch { toast.error("Failed to mark as accounted"); }
  };

  const clearChargesFilters = () => {
    setChargesContractFilter(""); setChargesStatusFilter("");
    setChargesDateFrom(""); setChargesDateTo(""); setChargesPage(1);
    setChargesSearchQuery("");
  };

  // chargesStatusFilter only counts as an active filter in History view —
  // in Unbilled it's unused (status is implicitly, always "pending").
  const hasChargesFilters = chargesContractFilter || (chargesView === "history" && chargesStatusFilter) || chargesDateFrom || chargesDateTo || chargesSearchQuery;

  // Client-side text search over already-fetched charges
  const filteredCharges = chargesSearchQuery.trim()
    ? charges.filter((c) => {
        const q = chargesSearchQuery.trim().toLowerCase();
        return (
          c.description.toLowerCase().includes(q) ||
          (c.contract?.contract_number || "").toLowerCase().includes(q) ||
          (c.booking?.booking_number || "").toLowerCase().includes(q) ||
          (c.lead?.first_name || "").toLowerCase().includes(q) ||
          (c.lead?.last_name || "").toLowerCase().includes(q) ||
          (c.lead?.company || "").toLowerCase().includes(q) ||
          (USAGE_STATUS_LABELS[c.status] || c.status).toLowerCase().includes(q) ||
          c.status.toLowerCase().includes(q)
        );
      })
    : charges;
  const isLocked      = summary?.period?.status === "locked";
  const selectedMonth = `${year}-${String(month).padStart(2, "0")}`;
  // Add-usage dialogs pre-fill to the month picked above, not the real
  // current date — a charge for a past month you're reviewing otherwise
  // silently lands in this month. Current month → today; past → its last
  // day; future → its first day.
  const defaultChargeDate = (() => {
    const today = new Date();
    const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (todayYmd.startsWith(selectedMonth)) return todayYmd;
    if (selectedMonth < todayYmd.slice(0, 7)) {
      const last = new Date(year, month, 0).getDate();
      return `${selectedMonth}-${String(last).padStart(2, "0")}`;
    }
    return `${selectedMonth}-01`;
  })();
  const pendingHandover = cashHandovers.filter((c) => c.cash_handover_status === "pending_handover");

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "Billing" }} />

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
        </>
      )}

      {/* ── Section selector (Phase 3) ─────────────────────────────────────
          Two working sections — everything else that used to compete for
          space here (Proposals, GST Invoices, Retained Payments, Electricity,
          Collections) is hidden as noise, not deleted: each tab's code and
          content stay reachable by deep link (?tab=...), see sectionForTab
          and SECTION_TABS above.
            • Billing for usage  — Usage Charges (capture + grouped billing) + Usage invoices
              (bill it) — one workflow, split into two steps of the same job.
            • Billing for rental — Rentals only. No sub-tab bar renders here
              since there's exactly one thing to show (see the Tabs block
              below) — GST Invoices/Retained Payments/Electricity/Collections
              stay mapped to "invoicing" for routing but aren't offered here.
          Renamed from "Receivables" so it no longer collides with the
          accounting-true /accounting/receivables page (invoiced-but-unpaid
          billing statements). This bucket is pre-invoice work-in-progress.
      */}
      <div className="flex flex-wrap gap-2 border-b pb-2">
        {([
          { key: "receivables", label: "Billing for usage", hint: "Usage charges & billing" },
          { key: "invoicing",   label: "Billing for rental", hint: "Billing & statements" },
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

      {/* Billing pipeline — visible in the Invoicing section */}
      {section === "invoicing" && pipeline && (
        <BillingPipelineBar
          data={pipeline}
          onStageClick={() => setActiveTab("rentals")}
        />
      )}

      {/* Sub-tabs — only the ones inside the active section render. "invoicing"
          renders no TabsList at all: with GST/Retained Payments/Electricity
          hidden, Rentals is the only thing left, so a one-item tab bar would
          just be noise above its own content. */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        {section !== "invoicing" && (
          <div className="overflow-x-auto pb-1">
            <TabsList className="w-max">
              {section === "receivables" && (
                <>
                  <TabsTrigger value="usage-charges">Usage Charges</TabsTrigger>
                  <TabsTrigger value="usage">Usage invoices</TabsTrigger>
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
            </TabsList>
          </div>
        )}

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
              const stmt = (cs as any).billing_statement as { id: string; status: string; statement_number: string } | null;
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
                  onFinalize={handleFinalizeStatement}
                  onMarkAccounted={handleMarkAccounted}
                  userRole={userRole}
                  onRecordStatementPayment={(statementId) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const stmtData = (cs as any).billing_statement;
                    const balance = computeSettlement(stmtData?.total_amount, stmtData?.billing_payments).balanceDue;
                    setRecordPaymentStatementId(statementId);
                    setRecordPaymentBalance(balance);
                    setRecordPaymentDialogOpen(true);
                  }}
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setChargesView("unbilled"); setChargesStatusFilter(""); setChargesPage(1); }}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold border transition-all ${chargesView === "unbilled" ? "bg-teal-700 text-white border-teal-700 shadow-sm" : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"}`}
            >
              Unbilled
            </button>
            <button
              type="button"
              onClick={() => { setChargesView("history"); setChargesStatusFilter(""); setChargesPage(1); }}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold border transition-all ${chargesView === "history" ? "bg-teal-700 text-white border-teal-700 shadow-sm" : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"}`}
            >
              Billed &amp; Waived History
            </button>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            {chargesView === "history" ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* Free-text search — description, contract#, booking#, customer, status */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={chargesSearchQuery}
                  onChange={(e) => setChargesSearchQuery(e.target.value)}
                  placeholder="Search description, contract, customer…"
                  className="pl-8 pr-8 h-9 w-[260px] text-sm"
                />
                {chargesSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setChargesSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
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
              {/* Unbilled is always exactly "pending" — nothing to choose.
                  History defaults to Billed+Waived combined; this narrows to
                  just one. Pending is deliberately absent as an option here
                  — that's what keeps History from becoming a second copy of
                  Unbilled. */}
              {chargesView === "history" && (
                <Select
                  value={chargesStatusFilter}
                  onValueChange={(val) => { setChargesStatusFilter(val === "all" ? "" : val); setChargesPage(1); }}
                >
                  <SelectTrigger className="w-[140px]"><SelectValue placeholder="Billed + Waived" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Billed + Waived</SelectItem>
                    <SelectItem value="billed">Billed</SelectItem>
                    <SelectItem value="waived">Waived</SelectItem>
                  </SelectContent>
                </Select>
              )}
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
            ) : (
              <p className="text-sm text-muted-foreground">
                Every unbilled charge. Each contract-month is one invoice, sent only when you click Review &amp; send.
              </p>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button><Plus className="mr-2 h-4 w-4" />Add usage</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setAddChargeOpen(true)}>
                  <Receipt className="mr-2 h-4 w-4" />Manual charge
                </DropdownMenuItem>
                {["admin", "accounts", "manager"].includes(userRole ?? "") && (
                  <DropdownMenuItem onClick={() => setPrintEntryOpen(true)}>
                    <Printer className="mr-2 h-4 w-4" />Print usage
                  </DropdownMenuItem>
                )}
                {["admin", "accounts", "manager"].includes(userRole ?? "") && (
                  <DropdownMenuItem onClick={() => setFacilityUsageOpen(true)}>
                    <Building2 className="mr-2 h-4 w-4" />Facility usage
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {chargesView === "unbilled" ? (
            <UsageBillingBoard
              refreshKey={boardRefreshKey}
              canSend={["admin", "manager", "accounts"].includes(userRole ?? "")}
              canWaive={["admin", "manager"].includes(userRole ?? "")}
              onChanged={refreshCharges}
              onWaive={(c, g) => { setWaiveChargeTarget(boardToUsageCharge(c, g)); setWaiveChargeReason(""); setWaiveChargeReasonError(false); }}
              onReduce={(c, g) => { setReduceChargeTarget(boardToUsageCharge(c, g)); setReduceChargeAmount(""); setReduceChargeReason(""); setReduceChargeError(null); }}
              onHold={(c, g) => { setHoldChargeTarget(boardToUsageCharge(c, g)); setHoldChargeReason(""); setHoldChargeReasonError(false); }}
              onRelease={(c, g) => void releaseChargeHold(boardToUsageCharge(c, g))}
              onReview={(c, g) => void submitReviewCharge(boardToUsageCharge(c, g))}
              onEdit={(c) => void openEditManualCharge(c.id)}
              onAddCharge={(contractId) => { setAddChargeContractId(contractId); setAddChargeOpen(true); }}
            />
          ) : (<>
          {chargesLoading ? (
            <TableSkeleton rows={6} />
          ) : filteredCharges.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No usage charges found"
              description={hasChargesFilters ? "Try adjusting your filters or search." : "Add your first usage charge to get started."}
              actionLabel={!hasChargesFilters ? "Add Charge" : undefined}
              onAction={!hasChargesFilters ? () => setAddChargeOpen(true) : undefined}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              {chargesSearchQuery.trim() && (
                <p className="text-xs text-muted-foreground px-4 py-2 border-b">
                  {filteredCharges.length} of {charges.length} charges match &ldquo;{chargesSearchQuery}&rdquo;
                </p>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Description</th>
                    <th className="px-4 py-3 text-left font-medium">Customer</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Reference</th>
                    <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Source</th>
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
                  {filteredCharges.map((charge) => (
                    <tr key={charge.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium max-w-[200px] truncate">{charge.description}</td>
                      <td className="px-4 py-3 max-w-[160px] truncate" title={customerNameOf(charge.lead)}>{customerNameOf(charge.lead)}</td>
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
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <Badge variant="outline" className={USAGE_SOURCE_COLORS[charge.source ?? "manual"]}>
                          {USAGE_SOURCE_LABELS[charge.source ?? "manual"]}
                        </Badge>
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
                        {/* Only print/facility rows carry a real billable/non-billable
                            distinction — a manual charge is always billable unless
                            waived, which the status badge above already communicates. */}
                        {charge.billable === false && (
                          <span className="block text-[11px] text-muted-foreground mt-0.5">Non-billable — within quota</span>
                        )}
                        {charge.billing_cycle_status && charge.billing_cycle_label && (
                          <Badge
                            variant="outline"
                            className={`block w-fit mt-1 text-[10px] ${BILLING_CYCLE_TAG[charge.billing_cycle_status]?.className ?? ""}`}
                          >
                            Bills in: {charge.billing_cycle_label} · {BILLING_CYCLE_TAG[charge.billing_cycle_status]?.text}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => {
                                setViewingCharge(charge);
                                setViewChargeOpen(true);
                              }}
                            >
                              <Eye className="mr-2 h-4 w-4" />View Details
                            </DropdownMenuItem>
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
          </>)}
        </TabsContent>

        {/* ── Electricity Bills ─────────────────────────────────────────── */}
        <TabsContent value="electricity" className="mt-4">
          <ElectricityBillsTab />
        </TabsContent>

        {/* ── Rentals ───────────────────────────────────────────────────── */}
        <TabsContent value="rentals" className="space-y-6 mt-4">
          {/* Unbilled | Billed, rent-only — persistent, cross-month view. Not
              scoped to the page-level MonthPicker above (that still drives
              the other tabs on this page) — Unbilled computes its own "now",
              Billed is unscoped. */}
          <UnbilledBilledTabs type="rent" userRole={userRole} onFinalized={refreshAfterRun} onViewStatement={setViewStatementId} />
        </TabsContent>

        {/* ── Usage ─────────────────────────────────────────────────────── */}
        <TabsContent value="usage" className="space-y-6 mt-4">
          {/* Usage invoice statements (all statuses). Unbilled usage is billed from Usage
              Charges → Unbilled (UsageBillingBoard), grouped by contract and
              month. */}
          <UnbilledBilledTabs type="usage" userRole={userRole} onFinalized={refreshAfterRun} onViewStatement={setViewStatementId} />
        </TabsContent>
      </Tabs>

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      <ExportSummaryDialog open={showExport} onOpenChange={setShowExport} year={year} month={month} />
      <AddUsageChargeDialog
        key={addChargeContractId ?? "any"}
        open={addChargeOpen}
        onOpenChange={(o) => { setAddChargeOpen(o); if (!o) setAddChargeContractId(undefined); }}
        onSuccess={refreshCharges}
        defaultChargeDate={defaultChargeDate}
        contractId={addChargeContractId}
      />
      <EditUsageChargeDialog
        open={editChargeOpen}
        onOpenChange={setEditChargeOpen}
        onSuccess={refreshCharges}
        charge={editingCharge}
      />
      <UsageChargeDetailsDialog
        open={viewChargeOpen}
        onOpenChange={setViewChargeOpen}
        charge={viewingCharge}
      />
      <ManualPrintEntryDialog open={printEntryOpen} onOpenChange={setPrintEntryOpen} onSuccess={refreshCharges} defaultPeriod={{ year, month }} />
      <LogFacilityUsageDialog open={facilityUsageOpen} onOpenChange={setFacilityUsageOpen} onSuccess={refreshCharges} defaultPeriod={{ year, month }} />

      {/* Waive fully */}
      <Dialog open={!!waiveChargeTarget} onOpenChange={(open) => { if (!open) setWaiveChargeTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Ban className="h-4 w-4" />Waive this charge</DialogTitle>
            <DialogDescription>
              {waiveChargeTarget && (
                <>&ldquo;{waiveChargeTarget.description}&rdquo; ({formatCurrency(waiveChargeTarget.total_with_gst ?? waiveChargeTarget.total)}) will be waived in full — the customer won&rsquo;t be billed for it.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="waive-charge-reason">Reason <span className="text-destructive">*</span></Label>
            <Textarea
              id="waive-charge-reason"
              value={waiveChargeReason}
              onChange={(e) => { setWaiveChargeReason(e.target.value); if (waiveChargeReasonError) setWaiveChargeReasonError(false); }}
              placeholder="Why is this being waived?"
              rows={3}
              className={waiveChargeReasonError ? "border-destructive" : ""}
            />
            {waiveChargeReasonError && <p className="text-xs text-destructive">Enter a reason first.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveChargeTarget(null)} disabled={waiveChargeSubmitting}>Cancel</Button>
            <Button onClick={submitWaiveCharge} disabled={waiveChargeSubmitting}>
              {waiveChargeSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Waive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Waive partly — reduce the amount, keep it as one pending line */}
      <Dialog open={!!reduceChargeTarget} onOpenChange={(open) => { if (!open) setReduceChargeTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><MinusCircle className="h-4 w-4" />Reduce this charge</DialogTitle>
            <DialogDescription>
              {reduceChargeTarget && (
                <>&ldquo;{reduceChargeTarget.description}&rdquo; is currently {formatCurrency(reduceChargeTarget.total)}. Enter the new (lower) amount — it stays pending and billable at that reduced amount.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="reduce-charge-amount">New amount <span className="text-destructive">*</span></Label>
              <Input
                id="reduce-charge-amount"
                type="number"
                min="0"
                value={reduceChargeAmount}
                onChange={(e) => { setReduceChargeAmount(e.target.value); if (reduceChargeError) setReduceChargeError(null); }}
                placeholder="0"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reduce-charge-reason">Reason <span className="text-destructive">*</span></Label>
              <Textarea
                id="reduce-charge-reason"
                value={reduceChargeReason}
                onChange={(e) => { setReduceChargeReason(e.target.value); if (reduceChargeError) setReduceChargeError(null); }}
                placeholder="Why is this being reduced?"
                rows={3}
              />
            </div>
            {reduceChargeError && <p className="text-xs text-destructive">{reduceChargeError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReduceChargeTarget(null)} disabled={reduceChargeSubmitting}>Cancel</Button>
            <Button onClick={submitReduceCharge} disabled={reduceChargeSubmitting}>
              {reduceChargeSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reduce
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hold the charge's contract — pauses ALL future billing for it */}
      <Dialog open={!!holdChargeTarget} onOpenChange={(open) => { if (!open) setHoldChargeTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><PauseCircle className="h-4 w-4" />Hold this charge</DialogTitle>
            <DialogDescription>
              {holdChargeTarget && (
                <>&ldquo;{holdChargeTarget.description}&rdquo; won&rsquo;t go on any invoice while held — it stays in the list. Every other charge on <span className="font-mono text-xs text-teal-700">{holdChargeTarget.contract?.contract_number}</span> bills normally. Release the hold whenever it&rsquo;s ready.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="hold-charge-reason">Reason <span className="text-destructive">*</span></Label>
            <Textarea
              id="hold-charge-reason"
              value={holdChargeReason}
              onChange={(e) => { setHoldChargeReason(e.target.value); if (holdChargeReasonError) setHoldChargeReasonError(false); }}
              placeholder="Why is this charge being held?"
              rows={3}
              className={holdChargeReasonError ? "border-destructive" : ""}
            />
            {holdChargeReasonError && <p className="text-xs text-destructive">Enter a reason first.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldChargeTarget(null)} disabled={holdChargeSubmitting}>Cancel</Button>
            <Button onClick={submitHoldCharge} disabled={holdChargeSubmitting}>
              {holdChargeSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Place Hold
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <GenerateStatementDialog open={generateStatementOpen} onOpenChange={setGenerateStatementOpen} onSuccess={fetchStatements} />

      <ViewStatementDialog
        statementId={viewStatementId}
        open={!!viewStatementId}
        onOpenChange={(v) => { if (!v) setViewStatementId(null); }}
        onStatusChange={fetchStatements}
        userRole={userRole}
        onRecordPayment={(statementId, balanceDue) => {
          setRecordPaymentStatementId(statementId);
          setRecordPaymentBalance(balanceDue);
          setViewStatementId(null);
          setRecordPaymentDialogOpen(true);
        }}
      />

      <RecordPaymentDialog
        open={recordPaymentDialogOpen}
        onOpenChange={setRecordPaymentDialogOpen}
        statementId={recordPaymentStatementId}
        balanceDue={recordPaymentBalance}
        onSuccess={() => { fetchStatements(); fetchData(); }}
      />
    </div>
  );
}

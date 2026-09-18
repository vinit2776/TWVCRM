"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Loader2, IndianRupee, RefreshCw, ZoomIn, ChevronDown, ChevronRight,
  ExternalLink, PackageOpen, ShoppingCart, FileText, CreditCard,
  CheckCircle2, XCircle, Clock, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  PR_STATUS_LABELS, PR_STATUS_COLORS,
  PO_STATUS_LABELS, PO_STATUS_COLORS,
  BILL_APPROVAL_STATUS_LABELS, BILL_APPROVAL_STATUS_COLORS,
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  EXPENDITURE_TYPE_LABELS, EXPENDITURE_TYPE_COLORS,
  CENTER_SCOPED_DEPARTMENTS,
} from "@/lib/constants";
import type { Company } from "@/types";

// ── Types ─────────────────────────────────────────────────────────────────────

const DEPARTMENTS = CENTER_SCOPED_DEPARTMENTS;

const DEPT_LABELS: Record<string, string> = {
  pantry: "Pantry",
  maintenance: "Maintenance",
  administration: "Administration",
  asset: "Asset",
};

const DEPT_ICONS: Record<string, string> = {
  pantry: "🍽️",
  maintenance: "🔧",
  administration: "📋",
  asset: "📦",
};

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

type CenterBudgetRow = {
  location_id: string;
  location_name: string;
  monthly_budget: number | null;
  is_active: boolean;
  id: string | null;
  spent_this_month: number;
  provisional_this_month: number;
  utilisation_pct: number | null;
  is_over_budget: boolean;
};

type BudgetRow = {
  department: string;
  monthly_budget: number | null;
  is_active: boolean;
  notes: string | null;
  id: string | null;
  spent_this_month: number;
  amc_spent_this_month: number;
  utilisation_pct: number | null;
  is_over_budget: boolean;
  updated_at: string | null;
  updater: { full_name: string } | null;
  centers: CenterBudgetRow[];
  unattributed_spend_this_month: number;
};

type CenterEditState = { monthly_budget: string; is_active: boolean };

type MrRow = {
  id: string;
  pr_number: string;
  status: string;
  department: string;
  expenditure_type: string;
  total_estimated_amount: number;
  created_at: string;
  requester: { id: string; full_name?: string } | null;
};

type LinkedPo = {
  id: string;
  po_number: string;
  po_type: string;
  status: string;
  total_amount: number;
  created_at: string;
  expected_delivery_date?: string;
  ordered_at?: string;
  procurement_vendors: { id: string; name: string } | null;
  po_delivery_receipts: Array<{
    id: string; received_at: string; status: string;
    receiver: { id: string; full_name?: string } | null;
  }>;
  po_service_reports: Array<{ id: string; service_date: string; notes?: string }>;
  vendor_bills: Array<{
    id: string; bill_number: string; invoice_date: string;
    total_amount: number; payment_status: string; approval_status: string;
    approved_at?: string; payment_date?: string;
    approver: { id: string; full_name?: string } | null;
  }>;
};

type AuditEvent = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  created_at: string;
  entity_label: string;
  performer: { id: string; full_name?: string } | null;
};

type LifecycleData = {
  mr: { id: string; pr_number: string; status: string; created_at: string; approved_at?: string; rejection_reason?: string; requester?: { full_name?: string } | null; approver?: { full_name?: string } | null };
  linked_pos: LinkedPo[];
  audit_trail: AuditEvent[];
};

// ── Lifecycle inline view ─────────────────────────────────────────────────────

function LifecycleView({ data }: { data: LifecycleData }) {
  const { mr, linked_pos, audit_trail } = data;

  // Build milestone list
  const milestones: { label: string; done: boolean; date?: string; actor?: string; color: string; icon: React.ReactNode }[] = [];

  milestones.push({
    label: "MR Created",
    done: true,
    date: mr.created_at,
    actor: mr.requester?.full_name,
    color: "bg-blue-500",
    icon: <FileText className="h-3 w-3" />,
  });

  const submitted = audit_trail.find((e) => e.entity_id === mr.id && e.action === "submit");
  milestones.push({
    label: "Submitted for Approval",
    done: !!submitted || ["approved","partially_ordered","po_created"].includes(mr.status),
    date: submitted?.created_at,
    actor: submitted?.performer?.full_name,
    color: "bg-indigo-500",
    icon: <ArrowRight className="h-3 w-3" />,
  });

  const approved = mr.status !== "rejected" && mr.status !== "cancelled" && mr.approved_at;
  milestones.push({
    label: mr.status === "rejected" ? "Rejected" : "Approved",
    done: !!approved || mr.status === "rejected",
    date: mr.approved_at,
    actor: mr.approver?.full_name,
    color: mr.status === "rejected" ? "bg-red-500" : "bg-green-500",
    icon: mr.status === "rejected" ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />,
  });

  const hasPo = linked_pos.length > 0;
  milestones.push({
    label: `PO${linked_pos.length > 1 ? "s" : ""} Created${hasPo ? ` (${linked_pos.length})` : ""}`,
    done: hasPo,
    date: hasPo ? linked_pos[0].created_at : undefined,
    color: "bg-amber-500",
    icon: <ShoppingCart className="h-3 w-3" />,
  });

  const allReceipts = linked_pos.flatMap((p) => p.po_delivery_receipts ?? []);
  const allServices = linked_pos.flatMap((p) => p.po_service_reports ?? []);
  const hasDelivery = allReceipts.length > 0 || allServices.length > 0;
  milestones.push({
    label: "Goods Received / Service Done",
    done: hasDelivery,
    date: allReceipts[0]?.received_at ?? allServices[0]?.service_date,
    actor: allReceipts[0]?.receiver?.full_name,
    color: "bg-teal-500",
    icon: <PackageOpen className="h-3 w-3" />,
  });

  const allBills = linked_pos.flatMap((p) => p.vendor_bills ?? []);
  const hasBill = allBills.length > 0;
  milestones.push({
    label: `Invoice${allBills.length > 1 ? "s" : ""} Received${hasBill ? ` (${allBills.length})` : ""}`,
    done: hasBill,
    date: hasBill ? allBills[0].invoice_date : undefined,
    color: "bg-violet-500",
    icon: <FileText className="h-3 w-3" />,
  });

  const approvedBill = allBills.find((b) => b.approval_status === "approved");
  milestones.push({
    label: "Invoice Approved",
    done: !!approvedBill,
    date: approvedBill?.approved_at,
    actor: approvedBill?.approver?.full_name,
    color: "bg-purple-500",
    icon: <CheckCircle2 className="h-3 w-3" />,
  });

  const paidBill = allBills.find((b) => b.payment_status === "paid" || b.payment_status === "partially_paid");
  milestones.push({
    label: "Payment Made",
    done: !!paidBill,
    date: paidBill?.payment_date,
    color: "bg-emerald-600",
    icon: <CreditCard className="h-3 w-3" />,
  });

  return (
    <div className="space-y-4 pt-2">
      {/* Milestone timeline */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Lifecycle Milestones</p>
        <div className="relative">
          {/* vertical connector */}
          <div className="absolute left-[11px] top-3 bottom-3 w-px bg-border" />
          <div className="space-y-2">
            {milestones.map((m, i) => (
              <div key={i} className="flex items-start gap-2.5 relative">
                <div className={`mt-0.5 h-6 w-6 rounded-full flex items-center justify-center shrink-0 z-10 ${m.done ? m.color : "bg-muted border border-border"} text-white`}>
                  {m.done ? m.icon : <Clock className="h-3 w-3 text-muted-foreground" />}
                </div>
                <div className="flex-1 min-w-0 pb-1">
                  <p className={`text-xs font-medium leading-tight ${m.done ? "" : "text-muted-foreground"}`}>{m.label}</p>
                  {m.done && (m.date || m.actor) && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {m.date ? formatDate(m.date) : ""}
                      {m.actor ? ` · ${m.actor}` : ""}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Linked POs summary */}
      {linked_pos.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Linked Purchase Orders</p>
          <div className="space-y-1.5">
            {linked_pos.map((po) => (
              <div key={po.id} className="flex items-center gap-2 rounded border px-2.5 py-1.5 bg-background text-xs">
                <span className="font-mono font-semibold">{po.po_number}</span>
                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${PO_STATUS_COLORS[po.status] ?? "bg-gray-100 text-gray-800"}`}>
                  {PO_STATUS_LABELS[po.status] ?? po.status}
                </Badge>
                <span className="text-muted-foreground ml-auto">{formatCurrency(po.total_amount)}</span>
                {po.procurement_vendors && (
                  <span className="text-muted-foreground truncate max-w-[100px]">{po.procurement_vendors.name}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bills summary */}
      {allBills.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Vendor Invoices</p>
          <div className="space-y-1.5">
            {allBills.map((bill) => (
              <div key={bill.id} className="flex items-center gap-2 rounded border px-2.5 py-1.5 bg-background text-xs">
                <span className="font-mono font-semibold">{bill.bill_number}</span>
                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${BILL_APPROVAL_STATUS_COLORS[bill.approval_status] ?? ""}`}>
                  {BILL_APPROVAL_STATUS_LABELS[bill.approval_status] ?? bill.approval_status}
                </Badge>
                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${BILL_PAYMENT_STATUS_COLORS[bill.payment_status] ?? ""}`}>
                  {BILL_PAYMENT_STATUS_LABELS[bill.payment_status] ?? bill.payment_status}
                </Badge>
                <span className="ml-auto text-muted-foreground">{formatCurrency(bill.total_amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Audit trail */}
      {audit_trail.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Activity Log</p>
          <div className="space-y-1">
            {audit_trail.map((e) => (
              <div key={e.id} className="flex items-start gap-2 text-[10px] text-muted-foreground">
                <span className="shrink-0 w-[70px] text-right tabular-nums">{formatDate(e.created_at)}</span>
                <span className="font-mono text-foreground/70">{e.entity_label}</span>
                <span className="capitalize">{e.action.replace(/_/g, " ")}</span>
                {e.performer?.full_name && <span className="ml-auto shrink-0">— {e.performer.full_name}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pt-1">
        <Link
          href={`/procurement/requests/${data.mr.id}`}
          target="_blank"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Open full MR details <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

// ── MR row with expandable lifecycle ─────────────────────────────────────────

function MrDrillRow({ mr }: { mr: MrRow }) {
  const [expanded, setExpanded] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleData | null>(null);
  const [loading, setLoading] = useState(false);

  const toggleExpand = async () => {
    if (!expanded && !lifecycle) {
      setLoading(true);
      const res = await fetch(`/api/procurement/requests/${mr.id}/lifecycle`);
      if (res.ok) {
        const data = await res.json();
        setLifecycle(data);
      }
      setLoading(false);
    }
    setExpanded((v) => !v);
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header row */}
      <button
        onClick={toggleExpand}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="shrink-0 text-muted-foreground">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-semibold">{mr.pr_number}</span>
            <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${PR_STATUS_COLORS[mr.status] ?? "bg-gray-100 text-gray-800"}`}>
              {PR_STATUS_LABELS[mr.status] ?? mr.status}
            </Badge>
            {mr.expenditure_type && mr.expenditure_type !== "operational" && (
              <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${EXPENDITURE_TYPE_COLORS[mr.expenditure_type] ?? ""}`}>
                {EXPENDITURE_TYPE_LABELS[mr.expenditure_type]}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
            <span>{formatDate(mr.created_at)}</span>
            {mr.requester?.full_name && <span>· {mr.requester.full_name}</span>}
          </div>
        </div>

        <span className="shrink-0 font-semibold text-sm tabular-nums">
          {formatCurrency(mr.total_estimated_amount)}
        </span>
      </button>

      {/* Lifecycle panel */}
      {expanded && (
        <div className="border-t bg-muted/20 px-4 pb-4">
          {lifecycle ? (
            <LifecycleView data={lifecycle} />
          ) : loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading lifecycle…
            </div>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">Failed to load lifecycle data.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Deep-dive Sheet ───────────────────────────────────────────────────────────

function DeptDrilldownSheet({
  dept, year, month, budgetAmt, open, onClose,
}: {
  dept: string | null;
  year: number;
  month: number;
  budgetAmt: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const [mrs, setMrs] = useState<MrRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !dept) return;
    setMrs([]);
    setLoading(true);

    const fromDate = new Date(year, month - 1, 1).toISOString();
    const toDate = new Date(year, month, 0, 23, 59, 59).toISOString();

    fetch(
      `/api/procurement/requests?department=${dept}&from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}&limit=50`
    )
      .then((r) => r.json())
      .then((j) => setMrs(j.data ?? []))
      .finally(() => setLoading(false));
  }, [open, dept, year, month]);

  if (!dept) return null;

  const COMMITTED_STATUSES = ["approved", "partially_ordered", "po_created"];
  const operationalMrs = mrs.filter((m) => m.expenditure_type !== "amc");
  const amcMrs = mrs.filter((m) => m.expenditure_type === "amc");
  // Only committed (approved+) requests count as real spend — matches the budget
  // bar and approval gate. Draft/submitted/rejected/cancelled are shown in the
  // list below for visibility but excluded from this total.
  const operationalTotal = operationalMrs
    .filter((m) => COMMITTED_STATUSES.includes(m.status))
    .reduce((s, m) => s + Number(m.total_estimated_amount ?? 0), 0);
  const operationalPipeline = operationalMrs
    .filter((m) => m.status === "submitted")
    .reduce((s, m) => s + Number(m.total_estimated_amount ?? 0), 0);
  const amcTotal = amcMrs
    .filter((m) => COMMITTED_STATUSES.includes(m.status))
    .reduce((s, m) => s + Number(m.total_estimated_amount ?? 0), 0);

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0 gap-0">
        {/* Sheet header */}
        <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{DEPT_ICONS[dept]}</span>
            <div>
              <SheetTitle className="text-base">
                {DEPT_LABELS[dept]} — {MONTHS[month - 1]} {year}
              </SheetTitle>
              <p className="text-xs text-muted-foreground mt-0.5">All purchase requests for this department this month</p>
            </div>
          </div>

          {/* Summary row */}
          {!loading && mrs.length > 0 && (
            <div className="flex flex-wrap gap-3 mt-3">
              <div className="rounded-lg border bg-muted/40 px-3 py-2 flex-1 min-w-[120px]">
                <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Operational Spend</p>
                <p className="text-sm font-bold mt-0.5">{formatCurrency(operationalTotal)}</p>
                {budgetAmt && (
                  <p className="text-[10px] text-muted-foreground">of {formatCurrency(budgetAmt)} budget</p>
                )}
              </div>
              {operationalPipeline > 0 && (
                <div className="rounded-lg border bg-amber-50 border-amber-200 px-3 py-2 flex-1 min-w-[120px]">
                  <p className="text-[10px] text-amber-700 font-medium uppercase tracking-wide">In Pipeline</p>
                  <p className="text-sm font-bold text-amber-800 mt-0.5">{formatCurrency(operationalPipeline)}</p>
                  <p className="text-[10px] text-amber-600">Submitted, pending approval</p>
                </div>
              )}
              {amcTotal > 0 && (
                <div className="rounded-lg border bg-purple-50 border-purple-200 px-3 py-2 flex-1 min-w-[120px]">
                  <p className="text-[10px] text-purple-700 font-medium uppercase tracking-wide">AMC / Annual Contracts</p>
                  <p className="text-sm font-bold text-purple-800 mt-0.5">{formatCurrency(amcTotal)}</p>
                  <p className="text-[10px] text-purple-600">Excluded from budget</p>
                </div>
              )}
              <div className="rounded-lg border bg-muted/40 px-3 py-2 flex-1 min-w-[80px]">
                <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Total MRs</p>
                <p className="text-sm font-bold mt-0.5">{mrs.length}</p>
              </div>
            </div>
          )}
        </SheetHeader>

        {/* MR list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading requests…
            </div>
          ) : mrs.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No material requests found for {DEPT_LABELS[dept]} in {MONTHS[month - 1]} {year}.
            </div>
          ) : (
            <div className="space-y-3">
              {/* Operational MRs */}
              {operationalMrs.length > 0 && (
                <>
                  {amcMrs.length > 0 && (
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Operational ({operationalMrs.length})
                    </p>
                  )}
                  {operationalMrs.map((mr) => (
                    <MrDrillRow key={mr.id} mr={mr} />
                  ))}
                </>
              )}

              {/* AMC MRs */}
              {amcMrs.length > 0 && (
                <>
                  <Separator className="my-2" />
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-purple-700">
                    AMC / Annual Contracts ({amcMrs.length}) — excluded from budget
                  </p>
                  {amcMrs.map((mr) => (
                    <MrDrillRow key={mr.id} mr={mr} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── AMC budget summary type ───────────────────────────────────────────────────

type AmcBudgetSummary = {
  financial_year: number;
  annual_budget: number | null;
  is_active: boolean;
  notes: string | null;
  id: string | null;
  committed: number;
  provisional: number;
  utilisation_pct: number | null;
  is_over_budget: boolean;
  updater: { full_name: string } | null;
  updated_at: string | null;
};

// ── Helper: compute current financial year (April start) ─────────────────────

function getCurrentFY(): number {
  const now = new Date();
  const month = now.getMonth() + 1;
  return month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

function fyLabel(fy: number) {
  return `FY ${fy}-${String(fy + 1).slice(-2)}`;
}

// ── AMC Annual Budget Card ────────────────────────────────────────────────────

function AmcBudgetCard({
  summary,
  isAdmin,
  amcEdit,
  onAmcEditChange,
  onSave,
  saving,
}: {
  summary: AmcBudgetSummary;
  isAdmin: boolean;
  amcEdit: { annual_budget: string; is_active: boolean; notes: string };
  onAmcEditChange: (patch: Partial<{ annual_budget: string; is_active: boolean; notes: string }>) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const budgetAmt = parseFloat(amcEdit.annual_budget) || null;
  const committed = summary.committed;
  const provisional = summary.provisional;

  const committedPct = budgetAmt ? Math.min((committed / budgetAmt) * 100, 100) : 0;
  const provisionalPct = budgetAmt ? Math.min((provisional / budgetAmt) * 100, 100 - committedPct) : 0;
  const isOver = budgetAmt != null && committed > budgetAmt;
  const remaining = budgetAmt ? Math.max(0, budgetAmt - committed) : null;

  const pctColour = !budgetAmt
    ? "text-muted-foreground"
    : isOver
    ? "text-red-700"
    : committedPct >= 80
    ? "text-amber-700"
    : "text-green-700";

  return (
    <Card className={`border-purple-200 ${isOver ? "bg-red-50/20 border-red-200" : "bg-purple-50/30"}`}>
      <CardContent className="pt-4 pb-4 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">🔧</span>
            <div>
              <p className="font-semibold text-sm">AMC Contracts</p>
              <p className="text-[11px] text-purple-700 font-medium">{fyLabel(summary.financial_year)} · Annual Budget</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isOver && (
              <Badge variant="secondary" className="text-[10px] bg-red-100 text-red-700 px-1.5">Over Budget</Badge>
            )}
            {!isOver && amcEdit.is_active && budgetAmt && (
              <Badge variant="secondary" className="text-[10px] bg-purple-100 text-purple-700 px-1.5">Active</Badge>
            )}
            {!amcEdit.is_active && (
              <Badge variant="secondary" className="text-[10px] bg-gray-100 text-gray-500 px-1.5">Inactive</Badge>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-4">
          {/* Annual budget input */}
          <div className="flex-1 min-w-[140px] space-y-1">
            <Label className="text-xs text-muted-foreground">Annual Budget (₹)</Label>
            <div className="relative">
              <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                type="number"
                step="10000"
                min="0"
                value={amcEdit.annual_budget}
                onChange={(e) => onAmcEditChange({ annual_budget: e.target.value })}
                className="pl-8 h-8 text-sm"
                placeholder="e.g. 500000"
                disabled={!isAdmin}
              />
            </div>
          </div>

          {/* Spend breakdown */}
          <div className="flex-1 min-w-[180px] space-y-1.5">
            <p className="text-xs text-muted-foreground">FY Utilisation</p>

            {/* Stacked bar: committed (green/red) + provisional (amber) */}
            {budgetAmt ? (
              <div className="w-full h-3 rounded-full bg-muted overflow-hidden flex">
                <div
                  className={`h-full transition-all ${isOver ? "bg-red-500" : committedPct >= 80 ? "bg-amber-500" : "bg-green-500"}`}
                  style={{ width: `${committedPct}%` }}
                />
                {provisionalPct > 0 && (
                  <div
                    className="h-full bg-amber-300 opacity-80"
                    style={{ width: `${provisionalPct}%` }}
                  />
                )}
              </div>
            ) : (
              <div className="w-full h-3 rounded-full border border-dashed border-purple-300 bg-transparent" />
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
              <span className={`font-semibold ${pctColour}`}>
                {formatCurrency(committed)} committed
                {budgetAmt && <span className="font-normal text-muted-foreground"> / {formatCurrency(budgetAmt)}</span>}
              </span>
              {provisional > 0 && (
                <span className="text-amber-700 font-medium">
                  + {formatCurrency(provisional)} in pipeline
                </span>
              )}
              {remaining !== null && !isOver && (
                <span className="text-muted-foreground">{formatCurrency(remaining)} remaining</span>
              )}
              {isOver && (
                <span className="text-red-700 font-medium">
                  ↑ {formatCurrency(committed - (budgetAmt ?? 0))} over
                </span>
              )}
            </div>
          </div>

          {/* Active toggle */}
          {isAdmin && (
            <div className="flex flex-col items-center gap-1 pt-1">
              <Label className="text-xs text-muted-foreground">Active</Label>
              <Switch
                checked={amcEdit.is_active}
                onCheckedChange={(checked) => onAmcEditChange({ is_active: checked })}
              />
            </div>
          )}
        </div>

        {/* Notes */}
        {isAdmin && (
          <Input
            value={amcEdit.notes}
            onChange={(e) => onAmcEditChange({ notes: e.target.value })}
            className="h-7 text-xs text-muted-foreground"
            placeholder="Optional note (e.g. board approved ₹5L for FY26)"
          />
        )}

        {/* Save button + meta */}
        <div className="flex items-center justify-between gap-2">
          {summary.updated_at ? (
            <p className="text-[10px] text-muted-foreground">
              Last updated {new Date(summary.updated_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}
              {summary.updater ? ` by ${summary.updater.full_name}` : ""}
            </p>
          ) : <span />}
          {isAdmin && (
            <Button size="sm" onClick={onSave} disabled={saving} className="gap-1.5 h-7 text-xs">
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              {saving ? "Saving…" : "Save AMC Budget"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Per-center budget breakdown ───────────────────────────────────────────────

function CenterBreakdown({
  centers, unattributedSpend, centerEdits, onCenterEditChange, isAdmin, isCurrentMonth,
}: {
  centers: CenterBudgetRow[];
  unattributedSpend: number;
  centerEdits: Record<string, CenterEditState>;
  onCenterEditChange: (locationId: string, patch: Partial<CenterEditState>) => void;
  isAdmin: boolean;
  isCurrentMonth: boolean;
}) {
  const [open, setOpen] = useState(false);

  const sumOfCenters = centers.reduce((s, c) => {
    const edit = centerEdits[c.location_id];
    const amt = edit?.monthly_budget ? parseFloat(edit.monthly_budget) : 0;
    return s + (isNaN(amt) ? 0 : amt);
  }, 0);

  return (
    <div className="mt-3 pt-3 border-t">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-primary hover:underline"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Break down by center
        {sumOfCenters > 0 && <span className="text-muted-foreground font-normal">(sum: {formatCurrency(sumOfCenters)})</span>}
      </button>

      {open && (
        <div className="mt-2.5 space-y-2 pl-4">
          {centers.map((c) => {
            const edit = centerEdits[c.location_id] ?? { monthly_budget: "", is_active: false };
            const budgetAmt = parseFloat(edit.monthly_budget) || null;
            const pct = budgetAmt ? Math.min(Math.round((c.spent_this_month / budgetAmt) * 100), 110) : null;
            const isOver = budgetAmt != null && c.spent_this_month > budgetAmt;
            return (
              <div key={c.location_id} className="flex flex-wrap items-center gap-3">
                <span className="text-xs w-40 shrink-0 truncate" title={c.location_name}>{c.location_name}</span>
                <div className="relative w-32 shrink-0">
                  <IndianRupee className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                  <Input
                    type="number"
                    step="1000"
                    min="0"
                    value={edit.monthly_budget}
                    onChange={(e) => onCenterEditChange(c.location_id, { monthly_budget: e.target.value })}
                    className="pl-6 h-7 text-xs"
                    placeholder="0"
                    disabled={!isAdmin || !isCurrentMonth}
                  />
                </div>
                <div className="flex-1 min-w-[100px]">
                  <span className={`text-xs font-medium ${isOver ? "text-red-700" : pct != null && pct >= 80 ? "text-amber-700" : "text-muted-foreground"}`}>
                    {formatCurrency(c.spent_this_month)}
                    {budgetAmt && <span className="font-normal"> / {formatCurrency(budgetAmt)}</span>}
                  </span>
                  {budgetAmt ? (
                    <div className="w-full h-1 rounded-full bg-muted mt-0.5">
                      <div
                        className={`h-1 rounded-full ${isOver ? "bg-red-500" : pct != null && pct >= 80 ? "bg-amber-400" : "bg-green-500"}`}
                        style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                      />
                    </div>
                  ) : null}
                </div>
                {isAdmin && isCurrentMonth && (
                  <Switch
                    checked={edit.is_active}
                    onCheckedChange={(checked) => onCenterEditChange(c.location_id, { is_active: checked })}
                    className="shrink-0"
                  />
                )}
              </div>
            );
          })}
          {unattributedSpend > 0 && (
            <p className="text-[11px] text-muted-foreground italic pt-1">
              + {formatCurrency(unattributedSpend)} spent this month with no center set (older requests) — not counted against any center above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProcurementBudgetSettings({ userRole }: { userRole: string }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  // Budgets are entity-specific — no combined view, so a company must always
  // be selected. Defaults to the first company returned (Workvilla).
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string>("");
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [amcSummary, setAmcSummary] = useState<AmcBudgetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingAmc, setSavingAmc] = useState(false);

  // Drill-down state
  const [drillDept, setDrillDept] = useState<string | null>(null);

  // Editable state for operational departments
  const [edits, setEdits] = useState<Record<string, { monthly_budget: string; is_active: boolean; notes: string }>>({});

  // Editable state for per-center budgets — department -> location_id -> edit
  const [centerEdits, setCenterEdits] = useState<Record<string, Record<string, CenterEditState>>>({});

  // Editable state for AMC annual budget
  const [amcEdit, setAmcEdit] = useState<{ annual_budget: string; is_active: boolean; notes: string }>({
    annual_budget: "", is_active: false, notes: "",
  });

  const isCurrentMonth = year === now.getFullYear() && month === (now.getMonth() + 1);
  const isAdmin = userRole === "admin";
  const currentFY = getCurrentFY();

  // MR approval threshold — global, not scoped to company/month/year.
  const [approvalThreshold, setApprovalThreshold] = useState("");
  const [thresholdLoading, setThresholdLoading] = useState(true);
  const [savingThreshold, setSavingThreshold] = useState(false);

  useEffect(() => {
    fetch("/api/procurement/settings")
      .then((r) => r.json())
      .then((j) => setApprovalThreshold(String(j.data?.approval_threshold ?? "")))
      .finally(() => setThresholdLoading(false));
  }, []);

  const handleSaveThreshold = async () => {
    const threshold = parseInt(approvalThreshold, 10);
    if (isNaN(threshold) || threshold < 0) {
      toast.error("Enter a valid amount");
      return;
    }
    setSavingThreshold(true);
    const res = await fetch("/api/procurement/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold }),
    });
    if (res.ok) {
      toast.success("Approval threshold updated");
    } else {
      const json = await res.json().catch(() => ({}));
      toast.error(json.error || "Failed to update threshold");
    }
    setSavingThreshold(false);
  };

  // Companies — default to the first (Workvilla) once loaded, since this page
  // has no combined view and always needs exactly one company selected.
  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((j) => {
        const all: Company[] = j.data || [];
        setCompanies(all);
        if (!companyId && all.length > 0) setCompanyId(all[0].id);
      })
      .catch(() => setCompanies([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchBudgets = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    // Clear stale data up front so a company switch never shows the
    // previous company's departments/centers/AMC while the new fetch is in flight.
    setRows([]);
    setEdits({});
    setCenterEdits({});
    setAmcSummary(null);
    const res = await fetch(`/api/procurement/budget?company_id=${companyId}&year=${year}&month=${month}`);
    if (res.ok) {
      const json = await res.json();
      const safeRows: BudgetRow[] = Array.isArray(json.data) ? json.data : [];
      setRows(safeRows);

      const initial: Record<string, { monthly_budget: string; is_active: boolean; notes: string }> = {};
      const initialCenters: Record<string, Record<string, CenterEditState>> = {};
      for (const row of safeRows) {
        initial[row.department] = {
          monthly_budget: row.monthly_budget != null ? String(row.monthly_budget) : "",
          is_active: row.is_active,
          notes: row.notes ?? "",
        };
        const centerMap: Record<string, CenterEditState> = {};
        for (const c of row.centers ?? []) {
          centerMap[c.location_id] = {
            monthly_budget: c.monthly_budget != null ? String(c.monthly_budget) : "",
            is_active: c.is_active,
          };
        }
        initialCenters[row.department] = centerMap;
      }
      setEdits(initial);
      setCenterEdits(initialCenters);

      // AMC summary
      if (json.amc) {
        const amc: AmcBudgetSummary = json.amc;
        setAmcSummary(amc);
        setAmcEdit({
          annual_budget: amc.annual_budget != null ? String(amc.annual_budget) : "",
          is_active: amc.is_active,
          notes: amc.notes ?? "",
        });
      }
    }
    setLoading(false);
  }, [companyId, year, month]);

  useEffect(() => { fetchBudgets(); }, [fetchBudgets]);

  const handleCenterEditChange = (dept: string, locationId: string, patch: Partial<CenterEditState>) => {
    setCenterEdits((prev) => ({
      ...prev,
      [dept]: {
        ...prev[dept],
        [locationId]: { ...(prev[dept]?.[locationId] ?? { monthly_budget: "", is_active: false }), ...patch },
      },
    }));
  };

  // Save operational department budgets
  const handleSave = async () => {
    if (!companyId) { toast.error("Select a company first"); return; }
    setSaving(true);
    const budgets = DEPARTMENTS.map((dept) => ({
      department: dept,
      monthly_budget: edits[dept]?.monthly_budget ? parseFloat(edits[dept].monthly_budget) : null,
      is_active: edits[dept]?.is_active ?? false,
      notes: edits[dept]?.notes || null,
      centers: Object.entries(centerEdits[dept] ?? {}).map(([location_id, edit]) => ({
        location_id,
        monthly_budget: edit.monthly_budget ? parseFloat(edit.monthly_budget) : null,
        is_active: edit.is_active,
      })),
    }));

    const res = await fetch("/api/procurement/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: companyId, budgets }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "Failed to save budgets");
    } else {
      toast.success("Department budgets saved");
      fetchBudgets();
    }
    setSaving(false);
  };

  // Save AMC annual budget
  const handleSaveAmc = async () => {
    if (!companyId) { toast.error("Select a company first"); return; }
    setSavingAmc(true);
    const res = await fetch("/api/procurement/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: companyId,
        amc: {
          financial_year: currentFY,
          annual_budget: amcEdit.annual_budget ? parseFloat(amcEdit.annual_budget) : null,
          is_active: amcEdit.is_active,
          notes: amcEdit.notes || null,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "Failed to save AMC budget");
    } else {
      toast.success("AMC annual budget saved");
      fetchBudgets();
    }
    setSavingAmc(false);
  };

  const utilColour = (pct: number | null, isOver: boolean) => {
    if (pct == null) return "text-muted-foreground";
    if (isOver) return "text-red-700";
    if (pct >= 80) return "text-amber-700";
    return "text-green-700";
  };

  const barColour = (pct: number | null, isOver: boolean) => {
    if (pct == null) return "bg-muted";
    if (isOver) return "bg-red-500";
    if (pct >= 80) return "bg-amber-400";
    return "bg-green-500";
  };

  const drillEdit = drillDept ? edits[drillDept] : undefined;
  const drillBudgetAmt = drillEdit?.monthly_budget ? parseFloat(drillEdit.monthly_budget) : null;

  return (
    <div className="space-y-6">
      {/* ── MR Approval Thresholds — global, not scoped to company/month/year ── */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-4">
          <div>
            <h3 className="font-semibold text-base">Material Request Approval Thresholds</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Who can approve a material request on their own, and how large it can be before it needs the next role up.
            </p>
          </div>

          {thresholdLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left text-xs text-muted-foreground font-medium py-2">Role</th>
                    <th className="text-left text-xs text-muted-foreground font-medium py-2 w-28">Can approve</th>
                    <th className="text-right text-xs text-muted-foreground font-medium py-2 w-48">Threshold</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="py-2.5 font-medium">Admin</td>
                    <td className="py-2.5">
                      <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-700 px-1.5">Yes</Badge>
                    </td>
                    <td className="py-2.5 text-right text-muted-foreground italic">No limit</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2.5 font-medium">Manager</td>
                    <td className="py-2.5">
                      <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-700 px-1.5">Yes</Badge>
                    </td>
                    <td className="py-2.5">
                      <div className="relative ml-auto w-40">
                        <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          type="number"
                          step="1000"
                          min="0"
                          value={approvalThreshold}
                          onChange={(e) => setApprovalThreshold(e.target.value)}
                          className="pl-8 h-8 text-sm text-right"
                          disabled={!isAdmin}
                        />
                      </div>
                    </td>
                  </tr>
                  {["Sales Rep", "Floor Incharge", "Accounts", "Facility Manager", "Office Administrator", "IT Team"].map((role) => (
                    <tr key={role} className="border-b last:border-b-0">
                      <td className="py-2.5 text-muted-foreground">{role}</td>
                      <td className="py-2.5">
                        <Badge variant="secondary" className="text-[10px] bg-gray-100 text-gray-500 px-1.5">No</Badge>
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="text-xs text-muted-foreground bg-muted/30 rounded px-3 py-2 space-y-1">
            <p>— A manager is also blocked, regardless of amount, if the MR has no vendor quotation attached, or if approving it would exceed the department&apos;s (or AMC&apos;s) monthly budget. Only admin can override either.</p>
            <p>— Admin approval has no ceiling by design — it&apos;s the escalation path, not a role with a bigger number.</p>
          </div>

          {isAdmin && (
            <div className="flex justify-end">
              <Button size="sm" onClick={handleSaveThreshold} disabled={savingThreshold || thresholdLoading}>
                {savingThreshold ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                {savingThreshold ? "Saving…" : "Save Threshold"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Operational Department Budgets header ──────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-base">Department Procurement Budgets</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Monthly spending limits per department. Click spend to drill into individual MRs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={companyId} onValueChange={setCompanyId}>
            <SelectTrigger className="w-[150px] h-8 text-xs">
              <SelectValue placeholder="Select company" />
            </SelectTrigger>
            <SelectContent>
              {companies.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.brand_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(month)} onValueChange={(v) => setMonth(parseInt(v))}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={(v) => setYear(parseInt(v))}>
            <SelectTrigger className="w-[90px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={fetchBudgets} className="h-8 w-8 p-0">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {!isCurrentMonth && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Viewing historical data for {MONTHS[month - 1]} {year}. To edit budgets, switch to the current month.
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading budgets…
        </div>
      ) : (
        <div className="space-y-3">
          {/* ── 4 operational department cards ── */}
          {rows.map((row) => {
            const edit = edits[row.department] ?? { monthly_budget: "", is_active: false, notes: "" };
            const budgetAmt = parseFloat(edit.monthly_budget) || null;
            const pct = budgetAmt ? Math.min(Math.round((row.spent_this_month / budgetAmt) * 100), 110) : null;
            const isOver = budgetAmt != null && row.spent_this_month > budgetAmt;
            const hasSpend = row.spent_this_month > 0;

            return (
              <Card key={row.department} className={isOver ? "border-red-200 bg-red-50/20" : ""}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex flex-wrap items-start gap-4">
                    {/* Dept name */}
                    <div className="flex items-center gap-2 w-36 shrink-0">
                      <span className="text-xl">{DEPT_ICONS[row.department]}</span>
                      <div>
                        <p className="font-medium text-sm">{DEPT_LABELS[row.department]}</p>
                        {isOver && (
                          <Badge variant="secondary" className="text-[10px] bg-red-100 text-red-700 px-1.5 mt-0.5">
                            Over Budget
                          </Badge>
                        )}
                        {!isOver && edit.is_active && budgetAmt && (
                          <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-700 px-1.5 mt-0.5">
                            Active
                          </Badge>
                        )}
                        {!edit.is_active && (
                          <Badge variant="secondary" className="text-[10px] bg-gray-100 text-gray-500 px-1.5 mt-0.5">
                            Inactive
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Budget input */}
                    <div className="flex-1 min-w-[140px] space-y-1">
                      <Label className="text-xs text-muted-foreground">Monthly Budget (₹)</Label>
                      <div className="relative">
                        <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          type="number"
                          step="1000"
                          min="0"
                          value={edit.monthly_budget}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [row.department]: { ...prev[row.department], monthly_budget: e.target.value } }))}
                          className="pl-8 h-8 text-sm"
                          placeholder="e.g. 50000"
                          disabled={!isAdmin || !isCurrentMonth}
                        />
                      </div>
                    </div>

                    {/* Spend this month — clickable deep-dive */}
                    <div className="flex-1 min-w-[160px] space-y-1">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs text-muted-foreground">Spent This Month</p>
                        {hasSpend && (
                          <button
                            onClick={() => setDrillDept(row.department)}
                            className="text-[10px] text-primary flex items-center gap-0.5 hover:underline"
                            title="Deep dive — view all MRs"
                          >
                            <ZoomIn className="h-3 w-3" /> Drill down
                          </button>
                        )}
                      </div>
                      <button
                        className={`text-sm font-semibold text-left ${utilColour(pct, isOver)} ${hasSpend ? "hover:underline cursor-pointer" : "cursor-default"}`}
                        onClick={() => hasSpend && setDrillDept(row.department)}
                        disabled={!hasSpend}
                      >
                        {formatCurrency(row.spent_this_month)}
                        {budgetAmt && <span className="text-xs font-normal ml-1">/ {formatCurrency(budgetAmt)}</span>}
                      </button>

                      {budgetAmt ? (
                        <div className="w-full h-1.5 rounded-full bg-muted mt-1">
                          <div
                            className={`h-1.5 rounded-full transition-all ${barColour(pct, isOver)}`}
                            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                          />
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">No budget set</p>
                      )}

                      {pct != null && (
                        <p className={`text-xs font-medium ${utilColour(pct, isOver)}`}>
                          {isOver ? `${pct}% — ₹${(row.spent_this_month - (budgetAmt ?? 0)).toLocaleString("en-IN")} over` : `${pct}% used`}
                        </p>
                      )}
                    </div>

                    {/* Active toggle */}
                    {isAdmin && isCurrentMonth && (
                      <div className="flex flex-col items-center gap-1 pt-1">
                        <Label className="text-xs text-muted-foreground">Active</Label>
                        <Switch
                          checked={edit.is_active}
                          onCheckedChange={(checked) =>
                            setEdits((prev) => ({ ...prev, [row.department]: { ...prev[row.department], is_active: checked } }))
                          }
                        />
                      </div>
                    )}
                  </div>

                  {/* Notes */}
                  {isAdmin && isCurrentMonth && (
                    <div className="mt-3">
                      <Input
                        value={edit.notes}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [row.department]: { ...prev[row.department], notes: e.target.value } }))}
                        className="h-7 text-xs text-muted-foreground"
                        placeholder="Optional note for this budget (e.g. approved by board in March)"
                      />
                    </div>
                  )}

                  {/* Meta */}
                  {row.updated_at && (
                    <p className="text-[10px] text-muted-foreground mt-2">
                      Last updated {new Date(row.updated_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}
                      {row.updater ? ` by ${row.updater.full_name}` : ""}
                    </p>
                  )}

                  {/* Per-center breakdown */}
                  <CenterBreakdown
                    centers={row.centers ?? []}
                    unattributedSpend={row.unattributed_spend_this_month ?? 0}
                    centerEdits={centerEdits[row.department] ?? {}}
                    onCenterEditChange={(locationId, patch) => handleCenterEditChange(row.department, locationId, patch)}
                    isAdmin={isAdmin}
                    isCurrentMonth={isCurrentMonth}
                  />
                </CardContent>
              </Card>
            );
          })}

          {isAdmin && isCurrentMonth && (
            <div className="flex justify-end pt-2">
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? "Saving…" : "Save Department Budgets"}
              </Button>
            </div>
          )}

          {!isAdmin && (
            <p className="text-xs text-muted-foreground text-center pt-2">
              Budget configuration is admin-only. You are viewing current utilisation.
            </p>
          )}

          {/* ── AMC Annual Budget section ── */}
          <div className="pt-4 border-t space-y-3">
            <div>
              <h3 className="font-semibold text-base">AMC Annual Budget</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                Annual Maintenance Contract budget — covers all departments for the full financial year (Apr–Mar).
                Spend is committed when an AMC MR is approved; submitted-but-pending MRs show as provisional.
              </p>
            </div>

            {amcSummary ? (
              <AmcBudgetCard
                summary={amcSummary}
                isAdmin={isAdmin}
                amcEdit={amcEdit}
                onAmcEditChange={(patch) => setAmcEdit((prev) => ({ ...prev, ...patch }))}
                onSave={handleSaveAmc}
                saving={savingAmc}
              />
            ) : (
              <Card className="border-purple-200 bg-purple-50/30">
                <CardContent className="pt-4 pb-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">🔧</span>
                    <div>
                      <p className="font-semibold text-sm">AMC Contracts</p>
                      <p className="text-[11px] text-purple-700">{fyLabel(currentFY)} · Annual Budget</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="flex-1 min-w-[140px] space-y-1">
                      <Label className="text-xs text-muted-foreground">Annual Budget (₹)</Label>
                      <div className="relative">
                        <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          type="number"
                          step="10000"
                          min="0"
                          value={amcEdit.annual_budget}
                          onChange={(e) => setAmcEdit((p) => ({ ...p, annual_budget: e.target.value }))}
                          className="pl-8 h-8 text-sm"
                          placeholder="e.g. 500000"
                          disabled={!isAdmin}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <Label className="text-xs text-muted-foreground">Active</Label>
                      <Switch
                        checked={amcEdit.is_active}
                        onCheckedChange={(v) => setAmcEdit((p) => ({ ...p, is_active: v }))}
                        disabled={!isAdmin}
                      />
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="flex justify-end">
                      <Button size="sm" onClick={handleSaveAmc} disabled={savingAmc} className="gap-1.5 h-7 text-xs">
                        {savingAmc && <Loader2 className="h-3 w-3 animate-spin" />}
                        {savingAmc ? "Saving…" : "Save AMC Budget"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Deep-dive Sheet */}
      <DeptDrilldownSheet
        dept={drillDept}
        year={year}
        month={month}
        budgetAmt={drillBudgetAmt}
        open={!!drillDept}
        onClose={() => setDrillDept(null)}
      />
    </div>
  );
}

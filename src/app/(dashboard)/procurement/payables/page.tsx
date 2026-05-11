"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IndianRupee, ChevronLeft, ChevronRight, Loader2, CalendarClock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  PO_ADVANCE_PAYMENT_MODE_LABELS,
  PAYMENT_BATCH_TYPE_LABELS, PAYMENT_BATCH_TYPE_COLORS,
} from "@/lib/constants";
import { formatDate, formatCurrency, formatSmartDate, cn } from "@/lib/utils";
import { VendorEmailChip } from "@/components/finance-intelligence/vendor-email-chip";
import { computeBatchDate, formatBatchDate, batchDateLabel } from "@/lib/payment-batch";
import { toast } from "sonner";
import type { VendorBill, PurchaseOrder, PaymentBatchType } from "@/types";

const today = new Date().toISOString().split("T")[0];

function isOverdue(bill: VendorBill): boolean {
  return (
    !!bill.due_date &&
    bill.payment_status !== "paid" &&
    bill.due_date < today
  );
}

type BatchSummary = {
  tomorrow_date: string;
  count: number;
  total_amount: number;
  bills: { id: string; bill_number: string; vendor_name: string; total_amount: number; payment_batch_type: string }[];
};

type BatchTab = { key: string; label: string; date: string | null; count: number; total: number };

export default function PayablesPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"bills" | "advances">("bills");
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);

  // ── Bills state ────────────────────────────────────────────────────────────
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [loadingBills, setLoadingBills] = useState(true);
  const [activeBatchKey, setActiveBatchKey] = useState<string>("all");

  // ── Tomorrow's batch summary banner ───────────────────────────────────────
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);

  // ── Override batch dialog ─────────────────────────────────────────────────
  const [overrideBill, setOverrideBill] = useState<VendorBill | null>(null);
  const [overrideBatchType, setOverrideBatchType] = useState<PaymentBatchType | "">("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideLoading, setOverrideLoading] = useState(false);

  // ── Advances state ─────────────────────────────────────────────────────────
  const [pendingAdvances, setPendingAdvances] = useState<PurchaseOrder[]>([]);
  const [advancesTotal, setAdvancesTotal] = useState(0);
  const [loadingAdvances, setLoadingAdvances] = useState(false);
  const [advancesPagination, setAdvancesPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });

  // ── Process advance dialog ─────────────────────────────────────────────────
  const [processingPo, setProcessingPo] = useState<PurchaseOrder | null>(null);
  const [advancePaymentDate, setAdvancePaymentDate] = useState(today);
  const [processingLoading, setProcessingLoading] = useState(false);

  // ── Fetch current user role ───────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((j) => setCurrentUserRole(j.role ?? null))
      .catch(() => setCurrentUserRole(null));
  }, []);

  const canOverrideBatch = ["admin", "manager", "accounts"].includes(currentUserRole ?? "");

  const fetchBills = useCallback(async () => {
    setLoadingBills(true);
    // Fetch all approved unpaid bills (no pagination — we group client-side)
    const params = new URLSearchParams({
      approval_status: "approved",
      payment_status_neq: "paid",
      limit: "200",
      include_totals: "true",
    });
    const res = await fetch(`/api/procurement/bills?${params}`);
    if (res.ok) {
      const json = await res.json();
      setBills(json.data || []);
    }
    setLoadingBills(false);
  }, []);

  const fetchAdvances = useCallback(async () => {
    setLoadingAdvances(true);
    const params = new URLSearchParams({ advance_status: "pending", limit: "50" });
    const res = await fetch(`/api/procurement/orders?${params}`);
    if (res.ok) {
      const json = await res.json();
      setPendingAdvances(json.data || []);
      setAdvancesTotal(json.pagination?.total ?? 0);
      setAdvancesPagination(json.pagination ?? { page: 1, limit: 25, total: 0, totalPages: 0 });
    }
    setLoadingAdvances(false);
  }, []);

  const fetchBatchSummary = useCallback(async () => {
    const res = await fetch("/api/procurement/batch-summary");
    if (res.ok) {
      const json = await res.json();
      if (json.count > 0) setBatchSummary(json);
    }
  }, []);

  useEffect(() => { fetchBills(); }, [fetchBills]);
  useEffect(() => { fetchAdvances(); }, [fetchAdvances]);
  useEffect(() => { fetchBatchSummary(); }, [fetchBatchSummary]);

  // ── Derive batch tabs from bills ─────────────────────────────────────────
  const batchTabs = (() => {
    const grouped: Record<string, { bills: VendorBill[]; date: string | null }> = {
      all: { bills: [], date: null },
    };

    for (const b of bills) {
      grouped["all"].bills.push(b);
      const key = b.payment_batch_date ?? "unscheduled";
      if (!grouped[key]) grouped[key] = { bills: [], date: b.payment_batch_date ?? null };
      grouped[key].bills.push(b);
    }

    const tabs: BatchTab[] = [
      {
        key: "all",
        label: "All",
        date: null,
        count: grouped["all"].bills.length,
        total: grouped["all"].bills.reduce((s, b) => s + Number(b.total_amount) - Number(b.amount_paid), 0),
      },
    ];

    // Sort batch-date keys chronologically
    const dateKeys = Object.keys(grouped)
      .filter((k) => k !== "all" && k !== "unscheduled")
      .sort();

    for (const k of dateKeys) {
      const group = grouped[k];
      tabs.push({
        key: k,
        label: batchDateLabel(k),
        date: k,
        count: group.bills.length,
        total: group.bills.reduce((s, b) => s + Number(b.total_amount) - Number(b.amount_paid), 0),
      });
    }

    if (grouped["unscheduled"]?.bills.length) {
      tabs.push({
        key: "unscheduled",
        label: "Unscheduled",
        date: null,
        count: grouped["unscheduled"].bills.length,
        total: grouped["unscheduled"].bills.reduce((s, b) => s + Number(b.total_amount) - Number(b.amount_paid), 0),
      });
    }

    return tabs;
  })();

  const visibleBills = (() => {
    if (activeBatchKey === "all") return bills;
    if (activeBatchKey === "unscheduled") return bills.filter((b) => !b.payment_batch_date);
    return bills.filter((b) => b.payment_batch_date === activeBatchKey);
  })();

  const totalPayable = bills.reduce((s, b) => s + Number(b.total_amount), 0);
  const totalDue = bills.reduce((s, b) => s + (Number(b.total_amount) - Number(b.amount_paid)), 0);
  const overdueCount = bills.filter(isOverdue).length;
  const pendingAdvanceSum = pendingAdvances.reduce((s, po) => s + Number(po.advance_amount ?? 0), 0);

  const handleProcessAdvance = async () => {
    if (!processingPo) return;
    if (!advancePaymentDate) { toast.error("Payment date is required"); return; }
    setProcessingLoading(true);
    try {
      const res = await fetch(`/api/procurement/orders/${processingPo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process_advance", advance_payment_date: advancePaymentDate }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to process advance"); return; }
      toast.success("Advance payment marked as processed");
      setProcessingPo(null);
      setAdvancePaymentDate(today);
      await fetchAdvances();
    } finally {
      setProcessingLoading(false);
    }
  };

  const handleOverrideBatch = async () => {
    if (!overrideBill || !overrideBatchType) {
      toast.error("Select a new batch schedule");
      return;
    }
    setOverrideLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${overrideBill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "override_batch",
          batch_type: overrideBatchType,
          reason: overrideReason.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to update batch schedule"); return; }
      toast.success("Payment batch updated");
      setOverrideBill(null);
      setOverrideBatchType("");
      setOverrideReason("");
      await fetchBills();
      await fetchBatchSummary();
    } finally {
      setOverrideLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Payables</h1>
        <p className="text-sm text-muted-foreground">
          Approved vendor invoices and pending advance payments
        </p>
      </div>

      {/* ── Tomorrow's batch alert ──────────────────────────────────────── */}
      {batchSummary && batchSummary.count > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <CalendarClock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              Tomorrow — {batchSummary.count} bill{batchSummary.count > 1 ? "s" : ""} ({formatCurrency(batchSummary.total_amount)}) due for payment
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              Ensure funds are arranged for the{" "}
              <span className="font-medium">{formatDate(batchSummary.tomorrow_date)}</span> batch.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {batchSummary.bills.map((b) => (
                <Link
                  key={b.id}
                  href={`/procurement/bills/${b.id}`}
                  className="text-xs bg-amber-100 hover:bg-amber-200 text-amber-900 px-2 py-0.5 rounded-full transition-colors"
                >
                  {b.vendor_name} · {formatCurrency(b.total_amount)}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Top-level tabs: Bills / Advances ───────────────────────────── */}
      <div className="flex gap-1 border-b">
        <button
          className={cn(
            "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
            activeTab === "bills"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setActiveTab("bills")}
        >
          Bills
          {bills.length > 0 && (
            <span className="ml-2 rounded-full bg-primary/10 text-primary px-1.5 py-0.5 text-xs font-medium">
              {bills.length}
            </span>
          )}
        </button>
        <button
          className={cn(
            "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
            activeTab === "advances"
              ? "border-orange-500 text-orange-700"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setActiveTab("advances")}
        >
          Pending Advances
          {advancesTotal > 0 && (
            <span className="ml-2 rounded-full bg-orange-100 text-orange-800 px-1.5 py-0.5 text-xs font-medium">
              {advancesTotal}
            </span>
          )}
        </button>
      </div>

      {/* ── BILLS TAB ────────────────────────────────────────────────────── */}
      {activeTab === "bills" && (
        <>
          {/* Summary cards */}
          {!loadingBills && bills.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Bills Due</p>
                <p className="text-2xl font-bold mt-1">{bills.length}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Total Payable</p>
                <p className="text-2xl font-bold mt-1">{formatCurrency(totalPayable)}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Balance Due</p>
                <p className="text-2xl font-bold mt-1 text-red-600">{formatCurrency(totalDue)}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Overdue</p>
                <p className={cn("text-2xl font-bold mt-1", overdueCount > 0 ? "text-amber-600" : "text-green-600")}>
                  {overdueCount}
                </p>
              </div>
            </div>
          )}

          {/* Batch date tabs */}
          {!loadingBills && bills.length > 0 && (
            <div className="flex gap-1 overflow-x-auto pb-1 border-b">
              {batchTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveBatchKey(tab.key)}
                  className={cn(
                    "shrink-0 px-3 py-2 rounded-t text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
                    activeBatchKey === tab.key
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className={cn(
                      "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                      activeBatchKey === tab.key ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                    )}>
                      {tab.count}
                    </span>
                  )}
                  {tab.key !== "all" && tab.key !== "unscheduled" && (
                    <span className={cn(
                      "ml-1 text-[10px]",
                      activeBatchKey === tab.key ? "text-primary/70" : "text-muted-foreground/70"
                    )}>
                      · {formatCurrency(tab.total)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {loadingBills ? (
            <TableSkeleton rows={8} />
          ) : bills.length === 0 ? (
            <EmptyState
              icon={IndianRupee}
              title="No pending payables"
              description="All approved invoices have been paid. Great job!"
            />
          ) : visibleBills.length === 0 ? (
            <EmptyState
              icon={IndianRupee}
              title="No bills in this batch"
              description="Switch to a different batch tab to view bills."
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Bill #</th>
                    <th className="px-4 py-3 text-left font-medium">Vendor</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">PO #</th>
                    <th className="px-4 py-3 text-left font-medium">Payment Batch</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Due Date</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Total</th>
                    <th className="px-4 py-3 text-right font-medium">Balance</th>
                    {canOverrideBatch && (
                      <th className="px-4 py-3 text-center font-medium hidden md:table-cell">Batch</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visibleBills.map((bill) => {
                    const balance = Number(bill.total_amount) - Number(bill.amount_paid);
                    return (
                      <tr
                        key={bill.id}
                        className={cn(
                          "border-b hover:bg-muted/30 transition-colors cursor-pointer",
                          isOverdue(bill) && "bg-amber-50/60"
                        )}
                        onClick={() => router.push(`/procurement/bills/${bill.id}`)}
                      >
                        <td className="px-4 py-3 font-mono text-xs font-medium">
                          <Link
                            href={`/procurement/bills/${bill.id}`}
                            className="text-primary hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {bill.bill_number}
                          </Link>
                          {isOverdue(bill) && (
                            <span className="ml-1.5 text-xs text-amber-700 font-normal">Overdue</span>
                          )}
                          {bill.approved_at && (
                            <p
                              className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-emerald-700"
                              title={
                                bill.approval_code
                                  ? `Approval code: ${bill.approval_code}`
                                  : "Approved"
                              }
                            >
                              <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
                              <span className="truncate">
                                {bill.approver?.full_name ?? "—"} · {formatSmartDate(bill.approved_at)}
                              </span>
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span>{bill.procurement_vendors?.name ?? "—"}</span>
                            {bill.procurement_vendors?.id &&
                              !(bill.procurement_vendors as { contact_email?: string | null }).contact_email && (
                                <VendorEmailChip vendorId={bill.procurement_vendors.id} />
                              )}
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground font-mono text-xs">
                          {bill.purchase_orders ? (
                            <Link
                              href={`/procurement/orders/${bill.purchase_orders.id}`}
                              className="text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {bill.purchase_orders.po_number}
                            </Link>
                          ) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          {bill.payment_batch_date ? (
                            <div>
                              <Badge
                                variant="secondary"
                                className={bill.payment_batch_type ? PAYMENT_BATCH_TYPE_COLORS[bill.payment_batch_type] : "bg-gray-100 text-gray-700"}
                              >
                                {bill.payment_batch_type ? PAYMENT_BATCH_TYPE_LABELS[bill.payment_batch_type] : "—"}
                              </Badge>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {batchDateLabel(bill.payment_batch_date)}
                              </p>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs italic flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3 text-amber-500" />
                              Not scheduled
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                          {bill.due_date ? (
                            <span className={isOverdue(bill) ? "text-amber-700 font-medium" : ""}>
                              {formatDate(bill.due_date)}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className={BILL_PAYMENT_STATUS_COLORS[bill.payment_status]}>
                            {BILL_PAYMENT_STATUS_LABELS[bill.payment_status]}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {formatCurrency(bill.total_amount)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-red-600">
                          {formatCurrency(balance > 0 ? balance : 0)}
                        </td>
                        {canOverrideBatch && (
                          <td className="px-4 py-3 text-center hidden md:table-cell">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7 px-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOverrideBill(bill);
                                setOverrideBatchType(bill.payment_batch_type ?? "");
                                setOverrideReason("");
                              }}
                            >
                              Change Batch
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── ADVANCES TAB ─────────────────────────────────────────────────── */}
      {activeTab === "advances" && (
        <>
          {!loadingAdvances && pendingAdvances.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Pending Advances</p>
                <p className="text-2xl font-bold mt-1">{advancesTotal}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Total Advance Amount</p>
                <p className="text-2xl font-bold mt-1 text-orange-700">{formatCurrency(pendingAdvanceSum)}</p>
              </div>
            </div>
          )}

          {loadingAdvances ? (
            <TableSkeleton rows={5} />
          ) : pendingAdvances.length === 0 ? (
            <EmptyState
              icon={IndianRupee}
              title="No pending advances"
              description="All advance payments have been processed."
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">PO #</th>
                    <th className="px-4 py-3 text-left font-medium">Vendor</th>
                    <th className="px-4 py-3 text-right font-medium">Advance Amount</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Mode</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Reference</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Created</th>
                    <th className="px-4 py-3 text-center font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingAdvances.map((po) => {
                    const vendor = po.procurement_vendors as { name: string } | null;
                    return (
                      <tr
                        key={po.id}
                        className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => router.push(`/procurement/orders/${po.id}`)}
                      >
                        <td className="px-4 py-3 font-mono text-xs font-medium">
                          <Link
                            href={`/procurement/orders/${po.id}`}
                            className="text-primary hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {po.po_number}
                          </Link>
                        </td>
                        <td className="px-4 py-3 font-medium">{vendor?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-right font-bold text-orange-700">
                          {formatCurrency(po.advance_amount ?? 0)}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                          {PO_ADVANCE_PAYMENT_MODE_LABELS[po.advance_payment_mode ?? ""] ?? "—"}
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground font-mono text-xs">
                          {po.advance_payment_reference ?? "—"}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                          {formatDate(po.created_at)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Button
                            size="sm"
                            className="bg-orange-600 hover:bg-orange-700 text-white"
                            onClick={(e) => {
                              e.stopPropagation();
                              setProcessingPo(po);
                              setAdvancePaymentDate(today);
                            }}
                          >
                            Process Payment
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {advancesPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {advancesPagination.page} of {advancesPagination.totalPages}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" disabled><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Process Advance Dialog ────────────────────────────────────────── */}
      <Dialog
        open={!!processingPo}
        onOpenChange={() => { setProcessingPo(null); setAdvancePaymentDate(today); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Process Advance Payment</DialogTitle>
          </DialogHeader>
          {processingPo && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border p-3 space-y-1 text-sm">
                <p><span className="text-muted-foreground">PO:</span> <span className="font-mono font-medium">{processingPo.po_number}</span></p>
                <p><span className="text-muted-foreground">Vendor:</span> <span className="font-medium">{(processingPo.procurement_vendors as { name: string } | null)?.name ?? "—"}</span></p>
                <p><span className="text-muted-foreground">Amount:</span> <span className="font-bold text-orange-700">{formatCurrency(processingPo.advance_amount ?? 0)}</span></p>
                <p><span className="text-muted-foreground">Mode:</span> {PO_ADVANCE_PAYMENT_MODE_LABELS[processingPo.advance_payment_mode ?? ""] ?? "—"}</p>
                {processingPo.advance_payment_reference && (
                  <p><span className="text-muted-foreground">Reference:</span> <span className="font-mono">{processingPo.advance_payment_reference}</span></p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adv_date">Payment Date <span className="text-red-500">*</span></Label>
                <Input
                  id="adv_date"
                  type="date"
                  value={advancePaymentDate}
                  onChange={(e) => setAdvancePaymentDate(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setProcessingPo(null)}>Cancel</Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700"
              onClick={handleProcessAdvance}
              disabled={processingLoading}
            >
              {processingLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Confirm Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Override Batch Dialog ─────────────────────────────────────────── */}
      <Dialog
        open={!!overrideBill}
        onOpenChange={() => { setOverrideBill(null); setOverrideBatchType(""); setOverrideReason(""); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Payment Batch</DialogTitle>
          </DialogHeader>
          {overrideBill && (
            <div className="space-y-4 py-2">
              {/* Current batch info */}
              <div className="rounded-lg border p-3 text-sm space-y-1">
                <p><span className="text-muted-foreground">Bill:</span> <span className="font-mono font-medium">{overrideBill.bill_number}</span></p>
                <p><span className="text-muted-foreground">Vendor:</span> <span className="font-medium">{overrideBill.procurement_vendors?.name ?? "—"}</span></p>
                <p><span className="text-muted-foreground">Amount:</span> <span className="font-bold">{formatCurrency(overrideBill.total_amount)}</span></p>
                <p className="flex items-center gap-2">
                  <span className="text-muted-foreground">Current batch:</span>
                  {overrideBill.payment_batch_date ? (
                    <Badge variant="secondary" className={overrideBill.payment_batch_type ? PAYMENT_BATCH_TYPE_COLORS[overrideBill.payment_batch_type] : ""}>
                      {overrideBill.payment_batch_type ? PAYMENT_BATCH_TYPE_LABELS[overrideBill.payment_batch_type] : "—"}
                      {" · "}{batchDateLabel(overrideBill.payment_batch_date)}
                    </Badge>
                  ) : (
                    <span className="text-amber-700 font-medium text-xs">Not scheduled</span>
                  )}
                </p>
              </div>

              {/* New batch selector */}
              <div className="space-y-2">
                <Label>Move to batch <span className="text-red-500">*</span></Label>
                <div className="grid grid-cols-3 gap-2">
                  {(["immediate", "15th", "25th"] as PaymentBatchType[]).map((bt) => {
                    const d = computeBatchDate(bt);
                    const isSelected = overrideBatchType === bt;
                    return (
                      <button
                        key={bt}
                        type="button"
                        onClick={() => setOverrideBatchType(bt)}
                        className={cn(
                          "rounded-lg border px-3 py-3 text-left transition-colors",
                          isSelected
                            ? "border-blue-500 bg-blue-50 text-blue-900"
                            : "border-muted hover:bg-muted/50"
                        )}
                      >
                        <p className="text-sm font-semibold">{PAYMENT_BATCH_TYPE_LABELS[bt]}</p>
                        <p className={cn("text-xs mt-0.5", isSelected ? "text-blue-700" : "text-muted-foreground")}>
                          {formatBatchDate(d)}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Reason */}
              <div className="space-y-1.5">
                <Label htmlFor="override_reason">Reason <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Textarea
                  id="override_reason"
                  placeholder="e.g. vendor requested earlier payment…"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  rows={2}
                />
              </div>

              <p className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
                This change will be logged in the bill&apos;s audit history.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideBill(null)}>Cancel</Button>
            <Button
              onClick={handleOverrideBatch}
              disabled={overrideLoading || !overrideBatchType}
            >
              {overrideLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Update Batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

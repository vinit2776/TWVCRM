"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IndianRupee, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  PO_ADVANCE_PAYMENT_MODE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency, cn } from "@/lib/utils";
import { toast } from "sonner";
import type { VendorBill, PurchaseOrder } from "@/types";

const today = new Date().toISOString().split("T")[0];

function isOverdue(bill: VendorBill): boolean {
  return (
    !!bill.due_date &&
    bill.payment_status !== "paid" &&
    bill.due_date < today
  );
}

export default function PayablesPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"bills" | "advances">("bills");

  // ── Bills state ────────────────────────────────────────────────────────────
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [billsPagination, setBillsPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [totals, setTotals] = useState<{ totalPayable: number; totalPaid: number; overdueCount: number } | null>(null);
  const [loadingBills, setLoadingBills] = useState(true);
  const [billsPage, setBillsPage] = useState(1);

  // ── Advances state ─────────────────────────────────────────────────────────
  const [pendingAdvances, setPendingAdvances] = useState<PurchaseOrder[]>([]);
  const [loadingAdvances, setLoadingAdvances] = useState(false);
  const [advancesTotal, setAdvancesTotal] = useState(0);

  // ── Process advance dialog ─────────────────────────────────────────────────
  const [processingPo, setProcessingPo] = useState<PurchaseOrder | null>(null);
  const [advancePaymentDate, setAdvancePaymentDate] = useState(today);
  const [processingLoading, setProcessingLoading] = useState(false);

  const fetchBills = useCallback(async () => {
    setLoadingBills(true);
    const params = new URLSearchParams({
      page: String(billsPage),
      limit: "25",
      approval_status: "approved",
      payment_status_neq: "paid",
      include_totals: "true",
    });
    const res = await fetch(`/api/procurement/bills?${params}`);
    if (res.ok) {
      const json = await res.json();
      setBills(json.data || []);
      setBillsPagination(json.pagination);
      if (json.totals) setTotals(json.totals);
    }
    setLoadingBills(false);
  }, [billsPage]);

  const fetchAdvances = useCallback(async () => {
    setLoadingAdvances(true);
    const params = new URLSearchParams({ advance_status: "pending", limit: "50" });
    const res = await fetch(`/api/procurement/orders?${params}`);
    if (res.ok) {
      const json = await res.json();
      setPendingAdvances(json.data || []);
      setAdvancesTotal(json.pagination?.total ?? 0);
    }
    setLoadingAdvances(false);
  }, []);

  useEffect(() => { fetchBills(); }, [fetchBills]);
  useEffect(() => { fetchAdvances(); }, [fetchAdvances]);

  const totalPayable = totals?.totalPayable ?? 0;
  const totalDue = (totals?.totalPayable ?? 0) - (totals?.totalPaid ?? 0);
  const overdueCount = totals?.overdueCount ?? 0;

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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Payables</h1>
        <p className="text-sm text-muted-foreground">
          Approved vendor invoices and pending advance payments
        </p>
      </div>

      {/* Tab switcher */}
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
          {billsPagination.total > 0 && (
            <span className="ml-2 rounded-full bg-primary/10 text-primary px-1.5 py-0.5 text-xs font-medium">
              {billsPagination.total}
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
          {!loadingBills && billsPagination.total > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Bills Due</p>
                <p className="text-2xl font-bold mt-1">{billsPagination.total}</p>
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

          {loadingBills ? (
            <TableSkeleton rows={8} />
          ) : bills.length === 0 ? (
            <EmptyState
              icon={IndianRupee}
              title="No pending payables"
              description="All approved invoices have been paid. Great job!"
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Bill #</th>
                    <th className="px-4 py-3 text-left font-medium">Vendor</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">PO #</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Due Date</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Total</th>
                    <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Paid</th>
                    <th className="px-4 py-3 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => {
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
                        </td>
                        <td className="px-4 py-3 font-medium">
                          {bill.procurement_vendors?.name ?? "—"}
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
                        <td className="px-4 py-3 text-right hidden md:table-cell text-muted-foreground">
                          {bill.amount_paid > 0 ? formatCurrency(bill.amount_paid) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-red-600">
                          {formatCurrency(balance > 0 ? balance : 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {billsPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {billsPagination.page} of {billsPagination.totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={billsPage <= 1}
                  onClick={() => setBillsPage(billsPage - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={billsPage >= billsPagination.totalPages}
                  onClick={() => setBillsPage(billsPage + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
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
    </div>
  );
}

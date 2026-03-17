"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IndianRupee, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
} from "@/lib/constants";
import { formatDate, formatCurrency, cn } from "@/lib/utils";
import type { VendorBill } from "@/types";

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
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [totals, setTotals] = useState<{ totalPayable: number; totalPaid: number; overdueCount: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchBills = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: "25",
      approval_status: "approved",
      payment_status_neq: "paid",
      include_totals: "true",
    });
    const res = await fetch(`/api/procurement/bills?${params}`);
    if (res.ok) {
      const json = await res.json();
      setBills(json.data || []);
      setPagination(json.pagination);
      if (json.totals) setTotals(json.totals);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchBills(); }, [fetchBills]);

  const totalPayable = totals?.totalPayable ?? 0;
  const totalDue = (totals?.totalPayable ?? 0) - (totals?.totalPaid ?? 0);
  const overdueCount = totals?.overdueCount ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Payables</h1>
        <p className="text-sm text-muted-foreground">
          Approved vendor invoices ready for payment
        </p>
      </div>

      {/* Summary cards */}
      {!loading && pagination.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Bills Due</p>
            <p className="text-2xl font-bold mt-1">{pagination.total}</p>
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

      {loading ? (
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

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

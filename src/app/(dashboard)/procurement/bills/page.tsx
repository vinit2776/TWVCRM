"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Receipt, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  BILL_PAYMENT_STATUSES, BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
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

export default function VendorBillsPage() {
  const router = useRouter();
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchBills = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (statusFilter) params.set("payment_status", statusFilter);
    const res = await fetch(`/api/procurement/bills?${params}`);
    if (res.ok) {
      const json = await res.json();
      setBills(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter]);

  useEffect(() => { fetchBills(); }, [fetchBills]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Vendor Bills</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total bills</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select
            value={statusFilter}
            onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {BILL_PAYMENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{BILL_PAYMENT_STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => router.push("/procurement/bills/new")}>
            <Plus className="h-4 w-4 mr-1" /> New Bill
          </Button>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={8} />
      ) : bills.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No vendor bills"
          description="Record your first vendor bill to start tracking payments."
          actionLabel="New Bill"
          onAction={() => router.push("/procurement/bills/new")}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Bill #</th>
                <th className="px-4 py-3 text-left font-medium">Vendor</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">PO #</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Invoice #</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Invoice Date</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Due Date</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Total</th>
                <th className="px-4 py-3 text-right font-medium hidden lg:table-cell">Paid</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((bill) => (
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
                    {bill.invoice_number ?? "—"}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                    {formatDate(bill.invoice_date)}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                    {bill.due_date ? formatDate(bill.due_date) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className={BILL_PAYMENT_STATUS_COLORS[bill.payment_status]}>
                      {BILL_PAYMENT_STATUS_LABELS[bill.payment_status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right hidden md:table-cell font-medium">
                    {formatCurrency(bill.total_amount)}
                  </td>
                  <td className="px-4 py-3 text-right hidden lg:table-cell text-muted-foreground">
                    {bill.amount_paid > 0 ? formatCurrency(bill.amount_paid) : "—"}
                  </td>
                </tr>
              ))}
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

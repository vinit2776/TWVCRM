"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Receipt, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  BILL_APPROVAL_STATUS_LABELS, BILL_APPROVAL_STATUS_COLORS,
  AUTO_APPROVED_BADGE_CLASS, PROCUREMENT_DEPARTMENT_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency, cn } from "@/lib/utils";
import { poValidity, PO_VALIDITY_CLASS } from "@/lib/approval-display";
import { BillSearchBar, filtersToParams, parseBillFilters, type BillFilters } from "@/components/procurement/bill-search-bar";
import type { VendorBill, PurchaseRequest } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

const today = new Date().toISOString().split("T")[0];

function isOverdue(bill: VendorBill): boolean {
  return (
    !!bill.due_date &&
    bill.payment_status !== "paid" &&
    bill.due_date < today
  );
}

type QuickFilter = "all" | "pending_approval" | "ready_for_payment" | "rejected";

function quickFilterToFilters(qf: QuickFilter): Partial<BillFilters> {
  switch (qf) {
    case "pending_approval":  return { approval_status: "pending" };
    case "ready_for_payment": return { approval_status: "approved", payment_status_neq: "paid" };
    case "rejected":          return { approval_status: "rejected" };
    default:                  return {};
  }
}

function VendorBillsPageInner() {
  const router = useRouter();
  const urlParams = useSearchParams();
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [rejectedCount, setRejectedCount] = useState<number | null>(null);
  // Rejected purchase requests never become a PO or bill, so they only surface here.
  const [rejectedPrs, setRejectedPrs] = useState<PurchaseRequest[]>([]);
  const [rejectedPrTotal, setRejectedPrTotal] = useState(0);
  const rejectedView = quickFilter === "rejected";

  // Hydrate filters from URL on first render
  const [filters, setFilters] = useState<BillFilters>(
    () => parseBillFilters(new URLSearchParams(urlParams.toString())),
  );

  const fetchBills = useCallback(async (f: BillFilters) => {
    setLoading(true);
    const params = filtersToParams(f);
    // Layer quick filter on top
    const qfPatch = quickFilterToFilters(quickFilter);
    Object.entries(qfPatch).forEach(([k, v]) => { if (v) params.set(k, v as string); });
    if (!params.has("limit")) params.set("limit", "25");

    const res = await fetch(`/api/procurement/bills?${params}`);
    if (res.ok) {
      const json = await res.json();
      setBills(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);

    // Reflect to URL (without quick-filter — the tab itself shows that)
    const urlOnly = filtersToParams(f);
    const newQuery = urlOnly.toString();
    router.replace(`/procurement/bills${newQuery ? `?${newQuery}` : ""}`, { scroll: false });
  }, [router, quickFilter]);

  useEffect(() => { fetchBills(filters); }, [fetchBills, filters]);

  // Tab badge — independent of the other filters so it always shows the overall count.
  useEffect(() => {
    fetch("/api/procurement/bills?approval_status=rejected&limit=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setRejectedCount(j.pagination.total); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!rejectedView) return;
    // The PR list is limited to procurement roles; a 403 just hides the section.
    fetch("/api/procurement/requests?status=rejected&limit=10&include_quotations=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        setRejectedPrs(j?.data ?? []);
        setRejectedPrTotal(j?.pagination?.total ?? 0);
      })
      .catch(() => {});
  }, [rejectedView]);

  const handleQuickFilter = (qf: QuickFilter) => {
    setQuickFilter(qf);
    setFilters((f) => ({ ...f, page: "1" }));
  };

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Vendor Bills" }} />
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Vendor Bills</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total bills</p>
        </div>
        <Button onClick={() => router.push("/procurement/bills/new")}>
          <Plus className="h-4 w-4 mr-1" /> New Bill
        </Button>
      </div>

      {/* Search bar */}
      <BillSearchBar
        initialFilters={filters}
        onChange={setFilters}
        showExport
      />

      {/* Quick filter tabs */}
      <div className="flex gap-2">
        <Button
          variant={quickFilter === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => handleQuickFilter("all")}
        >
          All Bills
        </Button>
        <Button
          variant={quickFilter === "pending_approval" ? "default" : "outline"}
          size="sm"
          onClick={() => handleQuickFilter("pending_approval")}
          className={quickFilter !== "pending_approval" ? "border-yellow-200 text-yellow-800 hover:bg-yellow-50" : "bg-yellow-600 hover:bg-yellow-700"}
        >
          Pending Payment Approval
        </Button>
        <Button
          variant={quickFilter === "ready_for_payment" ? "default" : "outline"}
          size="sm"
          onClick={() => handleQuickFilter("ready_for_payment")}
          className={quickFilter !== "ready_for_payment" ? "border-green-200 text-green-800 hover:bg-green-50" : "bg-green-600 hover:bg-green-700"}
        >
          Ready for Payment
        </Button>
        <Button
          variant={quickFilter === "rejected" ? "default" : "outline"}
          size="sm"
          onClick={() => handleQuickFilter("rejected")}
          className={quickFilter !== "rejected" ? "border-red-200 text-red-800 hover:bg-red-50" : "bg-red-600 hover:bg-red-700"}
        >
          Rejected
          {rejectedCount !== null && rejectedCount > 0 && (
            <span className="ml-1.5 rounded-full bg-red-100 px-1.5 text-xs text-red-800">{rejectedCount}</span>
          )}
        </Button>
      </div>

      {loading ? (
        <TableSkeleton rows={8} />
      ) : bills.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={quickFilter === "pending_approval" ? "No bills pending payment approval" : quickFilter === "ready_for_payment" ? "No bills ready for payment" : rejectedView ? "No rejected bills" : "No vendor bills"}
          description={quickFilter === "all" ? "Record your first vendor bill to start tracking payments." : "No bills match the current filter."}
          actionLabel={quickFilter === "all" ? "New Bill" : undefined}
          onAction={quickFilter === "all" ? () => router.push("/procurement/bills/new") : undefined}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Bill #</th>
                <th className="px-4 py-3 text-left font-medium">Vendor</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">PO #</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Invoice Date</th>
                <th className="px-4 py-3 text-left font-medium">Approval</th>
                {rejectedView ? (
                  <th className="px-4 py-3 text-left font-medium">Rejection reason</th>
                ) : (
                  <th className="px-4 py-3 text-left font-medium">Payment</th>
                )}
                <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Total</th>
                {!rejectedView && <th className="px-4 py-3 text-right font-medium hidden lg:table-cell">Paid</th>}
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
                  onClick={() => {
                    pushTrailEntry({ href: `/procurement/bills/${bill.id}`, label: bill.bill_number });
                    router.push(`/procurement/bills/${bill.id}`);
                  }}
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium">
                    <Link
                      href={`/procurement/bills/${bill.id}`}
                      className="text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        pushTrailEntry({ href: `/procurement/bills/${bill.id}`, label: bill.bill_number });
                      }}
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
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/procurement/orders/${bill.purchase_orders.id}`}
                          className="text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {bill.purchase_orders.po_number}
                        </Link>
                        {(() => {
                          const v = poValidity(bill.purchase_orders.expected_delivery_date);
                          return v && bill.payment_status !== "paid" ? (
                            <Badge variant="outline" className={`text-[10px] ${PO_VALIDITY_CLASS[v.tone]}`}>
                              {v.label}
                            </Badge>
                          ) : null;
                        })()}
                      </div>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                    {formatDate(bill.invoice_date)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="secondary" className={`text-xs ${BILL_APPROVAL_STATUS_COLORS[bill.approval_status]}`}>
                        {BILL_APPROVAL_STATUS_LABELS[bill.approval_status]}
                      </Badge>
                      {bill.auto_approved && (
                        <Badge variant="secondary" className={`text-xs ${AUTO_APPROVED_BADGE_CLASS}`} title={bill.auto_approval_note ?? undefined}>
                          Auto-approved
                        </Badge>
                      )}
                    </div>
                  </td>
                  {rejectedView ? (
                    <td className="px-4 py-3 text-red-700 max-w-xs">
                      {bill.rejection_reason ?? "—"}
                    </td>
                  ) : (
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="secondary" className={BILL_PAYMENT_STATUS_COLORS[bill.payment_status]}>
                        {BILL_PAYMENT_STATUS_LABELS[bill.payment_status]}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {bill.companies?.brand_name ?? "—"}
                      </Badge>
                    </div>
                  </td>
                  )}
                  <td className="px-4 py-3 text-right hidden md:table-cell font-medium">
                    {formatCurrency(bill.total_amount)}
                  </td>
                  {!rejectedView && (
                    <td className="px-4 py-3 text-right hidden lg:table-cell text-muted-foreground">
                      {bill.amount_paid > 0 ? formatCurrency(bill.amount_paid) : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rejectedView && rejectedPrs.length > 0 && (
        <div className="space-y-2 pt-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-base font-semibold">Rejected purchase requests</h2>
            <span className="rounded-full bg-red-100 px-1.5 text-xs text-red-800">{rejectedPrTotal}</span>
            <span className="text-xs text-muted-foreground">Rejected before a PO or bill was created</span>
          </div>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">PR #</th>
                  <th className="px-4 py-3 text-left font-medium">Vendor (quotation)</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Rejected on</th>
                  <th className="px-4 py-3 text-right font-medium">Estimated</th>
                  <th className="px-4 py-3 text-left font-medium">Rejection reason</th>
                  <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Dept</th>
                </tr>
              </thead>
              <tbody>
                {rejectedPrs.map((pr) => {
                  const vendors = Array.from(new Set(
                    (pr.material_request_quotations ?? []).map((q) => q.vendor_name).filter(Boolean),
                  ));
                  return (
                    <tr
                      key={pr.id}
                      className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                      onClick={() => router.push(`/procurement/requests/${pr.id}`)}
                    >
                      <td className="px-4 py-3 font-mono text-xs font-medium">
                        <Link
                          href={`/procurement/requests/${pr.id}`}
                          className="text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {pr.pr_number}
                        </Link>
                      </td>
                      <td className="px-4 py-3">{vendors.length ? vendors.join(", ") : "—"}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                        {pr.approved_at ? formatDate(pr.approved_at) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{formatCurrency(pr.total_estimated_amount)}</td>
                      <td className="px-4 py-3 text-red-700 max-w-xs">{pr.rejection_reason ?? "—"}</td>
                      <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                        {PROCUREMENT_DEPARTMENT_LABELS[pr.department] ?? pr.department}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rejectedPrTotal > rejectedPrs.length && (
            <p className="text-sm text-muted-foreground">
              Showing {rejectedPrs.length} of {rejectedPrTotal}.{" "}
              <Link href="/procurement/requests?status=rejected" className="text-primary hover:underline">
                View all rejected requests
              </Link>
            </p>
          )}
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
              disabled={pagination.page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: String(pagination.page - 1) }))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: String(pagination.page + 1) }))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VendorBillsPage() {
  return (
    <Suspense fallback={<TableSkeleton rows={8} />}>
      <VendorBillsPageInner />
    </Suspense>
  );
}

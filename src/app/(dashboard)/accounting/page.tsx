"use client";

import { useState, useEffect, useCallback } from "react";
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
  FileText,
} from "lucide-react";
import { formatSmartDate } from "@/lib/utils";
import { VendorEmailChip } from "@/components/finance-intelligence/vendor-email-chip";
import {
  BillSearchBar, filtersToParams, EMPTY_FILTERS, type BillFilters,
} from "@/components/procurement/bill-search-bar";
import { FinanceGuideCard, GuideReopenButton } from "@/components/finance/finance-guide-card";

type VendorBillItem = {
  id: string;
  bill_number: string;
  invoice_date: string;
  due_date: string | null;
  total_amount: number;
  amount_paid: number;
  payment_status: string;
  approval_status: string;
  approved_amount: number | null;
  approved_amount_note: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_code: string | null;
  approver: { id: string; full_name: string } | null;
  payment_mode: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  vendor_id: string;
  po_id: string | null;
  procurement_vendors: { id: string; name: string; contact_email?: string | null } | null;
  purchase_orders: { id: string; po_number: string } | null;
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

  // Vendor-email audit widget (touch point C)
  const [emailAuditCount, setEmailAuditCount] = useState<number | null>(null);
  const [emailAuditHighPriority, setEmailAuditHighPriority] = useState(0);

  // Bill search (replaces the old simple textbox)
  const [filters, setFilters] = useState<BillFilters>({
    ...EMPTY_FILTERS,
    approval_status: "approved",
    limit: "300",
  });

  const fetchVendorBills = useCallback(async () => {
    setBillsLoading(true);
    const params = filtersToParams(filters);
    const res = await fetch(`/api/procurement/bills?${params}`);
    if (res.ok) {
      const { data } = await res.json();
      setVendorBills(data ?? []);
    }
    setBillsLoading(false);
  }, [filters]);

  // Auto-fetch on mount and whenever filters change (URL-state for free)
  useEffect(() => {
    if (activeTab === "vendor-payments") fetchVendorBills();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, filters]);

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
  const pendingBills     = vendorBills.filter((b) => b.payment_status !== "paid");
  const allPaidBills     = vendorBills.filter((b) => b.payment_status === "paid");
  const visiblePaidBills = allPaidBills.slice(0, historyLimit);

  const today = new Date().toISOString().split("T")[0];

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
              {/* Bill search + filters */}
              <BillSearchBar
                initialFilters={filters}
                baseFilters={{ approval_status: "approved" }}
                onChange={(f) => { setFilters(f); setHistoryLimit(10); }}
                showExport
                placeholder="Search by bill #, invoice #, vendor, PO, notes…"
              />

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
                          <th className="px-4 py-3 text-left font-medium">Bill #</th>
                          <th className="px-4 py-3 text-left font-medium">Vendor</th>
                          <th className="px-4 py-3 text-left font-medium hidden md:table-cell">PO</th>
                          <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Due</th>
                          <th className="px-4 py-3 text-right font-medium">Invoice</th>
                          <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Paid</th>
                          <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                          <th className="px-4 py-3 text-left font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingBills.map((bill) => {
                          const outstanding        = Math.max(0, Number(bill.total_amount) - Number(bill.amount_paid ?? 0));
                          const approvedCeiling    = Number(bill.approved_amount ?? bill.total_amount);
                          const approvedOutstanding = Math.max(0, approvedCeiling - Number(bill.amount_paid ?? 0));
                          const isPartialApproval  = bill.approved_amount !== null && bill.approved_amount < bill.total_amount;
                          const isOverdue          = !!(bill.due_date && bill.due_date < today);
                          return (
                            <tr
                              key={bill.id}
                              className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                              onClick={() => router.push(`/accounting/vendor-payments/${bill.id}`)}
                            >
                              <td className="px-4 py-3 font-mono text-xs font-medium">
                                {bill.bill_number}
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
                                {(bill.purchase_orders as { po_number: string } | null)?.po_number ?? "—"}
                              </td>
                              <td className="px-4 py-3 hidden sm:table-cell text-xs">
                                {bill.due_date ? (
                                  <span className={isOverdue ? "text-red-600 font-semibold flex items-center gap-1" : "text-muted-foreground"}>
                                    {isOverdue && <AlertCircle className="h-3 w-3" />}
                                    {new Date(bill.due_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}
                                  </span>
                                ) : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-4 py-3 text-right text-xs">
                                ₹{Number(bill.total_amount).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
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
                                    <span className="text-[10px] font-medium bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded-full w-fit">Part Approved</span>
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
                          <td colSpan={4} className="px-4 py-2.5 text-xs text-muted-foreground font-medium">
                            {pendingBills.length} bill{pendingBills.length !== 1 ? "s" : ""} pending payment
                          </td>
                          <td colSpan={3} className="px-4 py-2.5 text-right font-bold text-sm">
                            ₹{pendingBills.reduce((s, b) => s + Math.max(0, Number(b.total_amount) - Number(b.amount_paid ?? 0)), 0).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
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
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground hidden sm:table-cell">Invoice Date</th>
                              <th className="px-4 py-2.5 text-right font-medium text-xs text-muted-foreground">Amount</th>
                              <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground hidden sm:table-cell">Payment Date</th>
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
                                  {(bill.purchase_orders as { po_number: string } | null)?.po_number ?? "—"}
                                </td>
                                <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-muted-foreground">
                                  {bill.invoice_date
                                    ? new Date(bill.invoice_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "2-digit" })
                                    : "—"}
                                </td>
                                <td className="px-4 py-2.5 text-right text-xs font-medium">
                                  ₹{Number(bill.total_amount).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                                </td>
                                <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-muted-foreground">
                                  {bill.payment_date
                                    ? new Date(bill.payment_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "2-digit" })
                                    : "—"}
                                </td>
                                <td className="px-4 py-2.5">
                                  <span className="text-[10px] font-medium bg-green-100 text-green-800 px-1.5 py-0.5 rounded-full">Paid</span>
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
      </Tabs>
    </div>
  );
}

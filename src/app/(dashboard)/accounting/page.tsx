"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { MonthPicker } from "@/components/accounting/month-picker";
import { PeriodStatusBar } from "@/components/accounting/period-status-bar";
import { AgingBuckets } from "@/components/accounting/aging-buckets";
import { ContractAccountingRow } from "@/components/accounting/contract-accounting-row";
import { WalkinCollectionsTable } from "@/components/accounting/walkin-collections-table";
import { CashHandoverTable } from "@/components/accounting/cash-handover-table";
import { GstInvoiceEntry } from "@/components/accounting/gst-invoice-entry";
import { ExportSummaryDialog } from "@/components/accounting/export-summary-dialog";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Calculator, ScrollText, Banknote, HandCoins, Building2, AlertCircle } from "lucide-react";
import { PettyCashIssuance } from "@/components/accounting/petty-cash-issuance";
import { ActionRequiredBanner } from "@/components/accounting/action-required-banner";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

type VendorBillItem = {
  id: string; bill_number: string; invoice_date: string; due_date: string | null;
  total_amount: number; amount_paid: number; payment_status: string;
  vendor_id: string; po_id: string | null;
  procurement_vendors: { id: string; name: string } | null;
  purchase_orders: { id: string; po_number: string } | null;
};

export default function AccountingPage() {
  const now = new Date();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [cashHandovers, setCashHandovers] = useState<CashHandoverItem[]>([]);
  const [gstEntries, setGstEntries] = useState<GstEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isLocking, setIsLocking] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [activeTab, setActiveTab] = useState(searchParams.get("tab") ?? "contracts");

  // Vendor payments
  const [vendorBills, setVendorBills] = useState<VendorBillItem[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [billsLoaded, setBillsLoaded] = useState(false);

  // Get user role
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        const { data } = await supabase
          .from("users")
          .select("role")
          .eq("auth_id", user.id)
          .single();
        setUserRole(data?.role || "sales_rep");
      }
    });
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryRes, cashRes, gstRes] = await Promise.all([
        fetch(`/api/accounting/monthly-summary?year=${year}&month=${month}`),
        fetch(`/api/accounting/cash-handovers?year=${year}&month=${month}`),
        fetch(`/api/accounting/gst-invoices?year=${year}&month=${month}`),
      ]);

      if (summaryRes.ok) {
        const summaryData = await summaryRes.json();
        setSummary(summaryData.data);
      }

      if (cashRes.ok) {
        const cashData = await cashRes.json();
        setCashHandovers(cashData.data || []);
      }

      if (gstRes.ok) {
        const gstData = await gstRes.json();
        setGstEntries(gstData.data || []);
      }
    } catch {
      toast.error("Failed to load accounting data");
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const fetchVendorBills = useCallback(async (force = false) => {
    if (billsLoaded && !force) return;
    setBillsLoading(true);
    const res = await fetch("/api/procurement/bills?approval_status=approved&payment_status_neq=paid&limit=50");
    if (res.ok) {
      const { data } = await res.json();
      setVendorBills(data ?? []);
      setBillsLoaded(true);
    }
    setBillsLoading(false);
  }, [billsLoaded]);

  // Auto-fetch vendor bills when tab is already active on page load (e.g. ?tab=vendor-payments)
  useEffect(() => {
    if (activeTab === "vendor-payments") fetchVendorBills();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMonthChange = (newYear: number, newMonth: number) => {
    setYear(newYear);
    setMonth(newMonth);
  };

  const handleLockToggle = async () => {
    if (!summary?.period?.id) return;

    const isLocked = summary.period.status === "locked";
    const action = isLocked ? "unlock" : "lock";

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

  const isLocked = summary?.period?.status === "locked";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Calculator className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Accounting</h1>
        </div>
        <MonthPicker year={year} month={month} onChange={handleMonthChange} />
      </div>

      {loading ? (
        <TableSkeleton />
      ) : (
        <>
          {/* Period status + summary cards — only for roles with contract data */}
          {summary && (
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
                cashHandovers={cashHandovers.filter((c) => c.cash_handover_status === "pending_handover")}
                gstEntries={gstEntries as { contract_id: string; contract_number: string; company: string; total_billable: number; gst_invoice_number: string | null; gst_invoice_sent_at: string | null }[]}
                onSwitchTab={setActiveTab}
              />
            </>
          )}

          {/* Tabs — always rendered so Vendor Payments is always accessible */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              {summary && (
                <>
                  <TabsTrigger value="contracts">
                    Contracts ({summary.contracts.length})
                  </TabsTrigger>
                  <TabsTrigger value="walkin">
                    Walk-in Collections ({summary.walkin_payments.length})
                  </TabsTrigger>
                  <TabsTrigger value="cash">
                    Cash Handovers ({cashHandovers.filter((c) => c.cash_handover_status === "pending_handover").length} pending)
                  </TabsTrigger>
                  <TabsTrigger value="gst">
                    GST Invoices
                  </TabsTrigger>
                  <TabsTrigger value="petty-cash">
                    <Banknote className="h-3.5 w-3.5 mr-1" />Petty Cash
                  </TabsTrigger>
                </>
              )}
              <TabsTrigger value="vendor-payments" onClick={() => fetchVendorBills()}>
                <Building2 className="h-3.5 w-3.5 mr-1" />Vendor Payments
                {vendorBills.length > 0 && (
                  <span className="ml-1.5 bg-primary text-primary-foreground text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                    {vendorBills.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* Tab 1: Contracts */}
            <TabsContent value="contracts" className="space-y-3 mt-4">
              {!summary ? (
                <EmptyState icon={ScrollText} title="No data" description="Could not load accounting data for this period" />
              ) : summary.contracts.length === 0 ? (
                <EmptyState
                  icon={ScrollText}
                  title="No active contracts"
                  description="No contracts are active for this period"
                />
              ) : (
                summary.contracts.map((cs) => (
                  <ContractAccountingRow
                    key={cs.contract.id}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    summary={cs as any}
                    accountingPeriodId={summary.period?.id || ""}
                    isLocked={isLocked || false}
                    onRefresh={fetchData}
                  />
                ))
              )}
            </TabsContent>

            {/* Tab 2: Walk-in Collections */}
            <TabsContent value="walkin" className="mt-4">
              {summary && <WalkinCollectionsTable payments={summary.walkin_payments} />}
            </TabsContent>

            {/* Tab 3: Cash Handovers */}
            <TabsContent value="cash" className="space-y-6 mt-4">
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">Pending Handover</h3>
                <CashHandoverTable
                  items={cashHandovers.filter((c) => c.cash_handover_status === "pending_handover")}
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
            </TabsContent>

            {/* Tab 4: GST Invoices */}
            <TabsContent value="gst" className="mt-4">
              <GstInvoiceEntry entries={gstEntries} onRefresh={fetchData} />
            </TabsContent>

            {/* Tab 5: Petty Cash Issuance */}
            <TabsContent value="petty-cash" className="mt-4">
              <PettyCashIssuance />
            </TabsContent>

            {/* Tab 6: placeholder — content rendered outside summary gate below */}
            <TabsContent value="vendor-payments" />
          </Tabs>
        </>
      )}

      {/* Vendor Payments — always rendered regardless of monthly summary state */}
      {activeTab === "vendor-payments" && (
        <div className="mt-2">
          {billsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="animate-pulse bg-muted rounded-lg h-14" />
              ))}
            </div>
          ) : vendorBills.length === 0 ? (
            <EmptyState
              icon={Building2}
              title="No pending vendor payments"
              description="All approved invoices have been paid, or no invoices are pending payment."
            />
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b">
                    <th className="px-4 py-3 text-left font-medium">Bill #</th>
                    <th className="px-4 py-3 text-left font-medium">Vendor</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">PO</th>
                    <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Invoice Date</th>
                    <th className="px-4 py-3 text-left font-medium">Due Date</th>
                    <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {vendorBills.map((bill) => {
                    const outstanding = Number(bill.total_amount) - Number(bill.amount_paid ?? 0);
                    const today = new Date().toISOString().split("T")[0];
                    const isOverdue = bill.due_date && bill.due_date < today;
                    return (
                      <tr
                        key={bill.id}
                        className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                        onClick={() => router.push(`/accounting/vendor-payments/${bill.id}`)}
                      >
                        <td className="px-4 py-3 font-mono text-xs font-medium">{bill.bill_number}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium truncate max-w-[160px]">
                            {(bill.procurement_vendors as { name: string } | null)?.name ?? "—"}
                          </p>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">
                          {(bill.purchase_orders as { po_number: string } | null)?.po_number ?? "—"}
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground text-xs">
                          {new Date(bill.invoice_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {bill.due_date ? (
                            <span className={isOverdue ? "text-red-600 font-semibold flex items-center gap-1" : "text-muted-foreground"}>
                              {isOverdue && <AlertCircle className="h-3 w-3" />}
                              {new Date(bill.due_date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                              {isOverdue && " (overdue)"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">
                          ₹{outstanding.toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/20 border-t">
                    <td colSpan={5} className="px-4 py-2.5 text-xs text-muted-foreground font-medium">
                      {vendorBills.length} bill{vendorBills.length !== 1 ? "s" : ""} pending payment
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold text-sm">
                      ₹{vendorBills.reduce((s, b) => s + Math.max(0, Number(b.total_amount) - Number(b.amount_paid ?? 0)), 0).toLocaleString("en-IN", { minimumFractionDigits: 0 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Export dialog */}
      <ExportSummaryDialog
        open={showExport}
        onOpenChange={setShowExport}
        year={year}
        month={month}
      />
    </div>
  );
}

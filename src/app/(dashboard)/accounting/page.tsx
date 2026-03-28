"use client";

import { useState, useEffect, useCallback } from "react";
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
import { Calculator, ScrollText, Banknote, HandCoins } from "lucide-react";
import { PettyCashIssuance } from "@/components/accounting/petty-cash-issuance";

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

export default function AccountingPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [cashHandovers, setCashHandovers] = useState<CashHandoverItem[]>([]);
  const [gstEntries, setGstEntries] = useState<GstEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isLocking, setIsLocking] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [activeTab, setActiveTab] = useState("contracts");

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
      ) : summary ? (
        <>
          {/* Period status + summary cards */}
          <PeriodStatusBar
            period={summary.period}
            totals={summary.totals}
            userRole={userRole}
            onLockToggle={handleLockToggle}
            onExport={() => setShowExport(true)}
            isLocking={isLocking}
          />

          {/* Aging buckets */}
          <AgingBuckets buckets={summary.aging_buckets} />

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
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
            </TabsList>

            {/* Tab 1: Contracts */}
            <TabsContent value="contracts" className="space-y-3 mt-4">
              {summary.contracts.length === 0 ? (
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
              <WalkinCollectionsTable payments={summary.walkin_payments} />
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
          </Tabs>
        </>
      ) : (
        <EmptyState
          icon={Calculator}
          title="No data"
          description="Could not load accounting data for this period"
        />
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

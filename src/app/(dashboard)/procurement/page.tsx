"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ClipboardList, Package, Receipt, AlertTriangle,
  CheckCircle2, Clock, BarChart3, ArrowRight,
  IndianRupee, ShoppingCart, Truck, AlertCircle,
  CalendarClock, Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PO_STATUS_LABELS, PO_STATUS_COLORS,
  PROCUREMENT_DEPARTMENT_LABELS, PROCUREMENT_DEPARTMENT_COLORS,
  PR_STATUS_LABELS, PR_STATUS_COLORS,
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
} from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BillRow {
  id: string; bill_number?: string; total_amount: number; amount_paid: number;
  due_date?: string; invoice_date?: string; payment_status: string; created_at: string;
  procurement_vendors?: { id: string; name: string } | null;
  purchase_orders?: { id: string; po_number: string } | null;
}

interface MrPipelineRow {
  id: string; pr_number: string; department: string;
  total_estimated_amount: number; created_at: string; notes?: string;
  requester?: { id: string; full_name?: string } | null;
  purchase_request_items?: Array<{ id: string; item_name: string; quantity: number; unit: string; estimated_price?: number }>;
}

interface DashboardData {
  mrPendingApproval: number;
  mrApprovedCount: number;
  mrApprovedValue: number;
  mrThisMonth: number;
  openPoCount: number;
  openPoValue: number;
  spendThisMonth: number;
  billsPendingCount: number;
  billsPendingValue: number;
  mrByDepartment: Record<string, number>;
  poByStatus: Record<string, number>;
  topVendors: { name: string; amount: number }[];
  recentMrs: Array<{
    id: string; pr_number: string; department: string; status: string;
    total_estimated_amount: number; created_at: string;
    requester?: { full_name?: string } | null;
  }>;
  recentPos: Array<{
    id: string; po_number: string; status: string;
    total_ordered_amount: number; created_at: string;
    procurement_vendors?: { name: string } | null;
  }>;
  // Intelligence panels
  billsPaymentPipeline: BillRow[];
  billsPaymentTotal: number;
  billsOverdueCount: number;
  billsAwaitingApproval: BillRow[];
  billsAwaitingTotal: number;
  mrApprovalPipeline: MrPipelineRow[];
  mrPipelineValue: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Shimmer({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded ${className ?? ""}`} />;
}

function SkeletonCard() {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <Shimmer className="h-4 w-32 mb-2" />
        <Shimmer className="h-8 w-16 mb-1" />
        <Shimmer className="h-3 w-24" />
      </CardContent>
    </Card>
  );
}

function getDaysUntilDue(dueDate?: string): number | null {
  if (!dueDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate); due.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function DueBadge({ dueDate }: { dueDate?: string }) {
  const days = getDaysUntilDue(dueDate);
  if (days === null) return <span className="text-xs text-muted-foreground">No due date</span>;
  if (days < 0) return <Badge className="bg-red-100 text-red-700 text-xs">{Math.abs(days)}d overdue</Badge>;
  if (days === 0) return <Badge className="bg-red-100 text-red-700 text-xs">Due today</Badge>;
  if (days <= 7) return <Badge className="bg-amber-100 text-amber-700 text-xs">Due in {days}d</Badge>;
  return <span className="text-xs text-muted-foreground">{formatDate(dueDate!)}</span>;
}

function getWaitingDays(createdAt: string): number {
  const created = new Date(createdAt);
  const today = new Date();
  return Math.floor((today.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
}

function KpiCard({
  icon: Icon, label, value, sub, href, alert,
}: {
  icon: React.ElementType; label: string; value: string | number; sub?: string;
  href?: string; alert?: boolean;
}) {
  const router = useRouter();
  return (
    <Card
      className={`${href ? "cursor-pointer hover:shadow-md transition-shadow" : ""} ${alert ? "border-amber-300" : ""}`}
      onClick={href ? () => router.push(href) : undefined}
    >
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground mb-1">{label}</p>
            <p className={`text-2xl font-bold ${alert ? "text-amber-600" : ""}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={`rounded-full p-2 ${alert ? "bg-amber-100" : "bg-muted"}`}>
            <Icon className={`h-5 w-5 ${alert ? "text-amber-600" : "text-muted-foreground"}`} />
          </div>
        </div>
        {href && (
          <div className="flex items-center gap-1 mt-3 text-xs text-muted-foreground hover:text-foreground">
            View all <ArrowRight className="h-3 w-3" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const DEPT_ORDER = ["pantry", "maintenance", "administration", "asset"];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProcurementDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState("");

  const fetchData = () => {
    setLoading(true);
    fetch("/api/procurement/dashboard")
      .then((r) => r.json())
      .then((j) => { if (j.data) setData(j.data); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((j) => setUserRole(j.role ?? ""));
    fetchData();
  }, []);

  const canSeePrices = ["admin", "manager"].includes(userRole);
  const currentMonth = new Date().toLocaleString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-6 w-6" />
            Procurement Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{currentMonth} · Live overview</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData}>Refresh</Button>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : data ? (
          <>
            <KpiCard
              icon={Clock}
              label="Pending Approval"
              value={data.mrPendingApproval}
              sub="Material Requests"
              href="/procurement/requests?status=submitted"
              alert={data.mrPendingApproval > 0}
            />
            <KpiCard
              icon={CheckCircle2}
              label="Approved, Awaiting PO"
              value={data.mrApprovedCount}
              sub={canSeePrices ? formatCurrency(data.mrApprovedValue) : undefined}
              href="/procurement/requests?status=approved"
            />
            <KpiCard
              icon={Package}
              label="Open Purchase Orders"
              value={data.openPoCount}
              sub={canSeePrices ? formatCurrency(data.openPoValue) : undefined}
              href="/procurement/orders"
            />
            {canSeePrices ? (
              <KpiCard
                icon={IndianRupee}
                label="Spend This Month"
                value={formatCurrency(data.spendThisMonth)}
                sub={`${data.mrThisMonth} MRs raised`}
              />
            ) : (
              <KpiCard
                icon={ClipboardList}
                label="MRs This Month"
                value={data.mrThisMonth}
                sub="Material Requests raised"
                href="/procurement/requests"
              />
            )}
          </>
        ) : null}
      </div>

      {/* ── Intelligence Panels ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Panel 1: MR Approval Pipeline */}
        <Card className={data?.mrApprovalPipeline?.length ? "border-amber-200" : ""}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Requests Awaiting Your Approval
                {data?.mrApprovalPipeline?.length ? (
                  <Badge className="bg-amber-100 text-amber-700 ml-1">{data.mrApprovalPipeline.length}</Badge>
                ) : null}
              </CardTitle>
              <Link href="/procurement/requests?status=submitted" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                Review all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            {canSeePrices && data?.mrPipelineValue ? (
              <p className="text-xs text-muted-foreground mt-0.5">
                Total value pending: <span className="font-medium text-foreground">{formatCurrency(data.mrPipelineValue)}</span>
              </p>
            ) : null}
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-3">
                {[1,2,3].map((i) => <Shimmer key={i} className="h-14 w-full" />)}
              </div>
            ) : !data?.mrApprovalPipeline?.length ? (
              <div className="px-4 py-8 text-center">
                <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-green-700">All clear</p>
                <p className="text-xs text-muted-foreground mt-1">No requests waiting for approval.</p>
              </div>
            ) : (
              <div className="divide-y">
                {data.mrApprovalPipeline.map((mr) => {
                  const waitDays = getWaitingDays(mr.created_at);
                  return (
                    <Link
                      key={mr.id}
                      href={`/procurement/requests/${mr.id}`}
                      className="flex items-start justify-between px-4 py-3 hover:bg-muted/30 transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-semibold text-primary">{mr.pr_number}</span>
                          <Badge variant="secondary" className={`text-xs ${PROCUREMENT_DEPARTMENT_COLORS[mr.department] ?? ""}`}>
                            {PROCUREMENT_DEPARTMENT_LABELS[mr.department] ?? mr.department}
                          </Badge>
                          {waitDays >= 2 && (
                            <Badge className={`text-xs ${waitDays >= 5 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                              Waiting {waitDays}d
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {mr.requester?.full_name ?? "Unknown"} · {mr.purchase_request_items?.length ?? 0} item{(mr.purchase_request_items?.length ?? 0) !== 1 ? "s" : ""}
                          {canSeePrices && mr.total_estimated_amount > 0 && (
                            <span className="ml-2 font-medium text-foreground">{formatCurrency(mr.total_estimated_amount)}</span>
                          )}
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Panel 2: Vendor Bills — Payment Due */}
        {canSeePrices ? (
          <Card className={data?.billsPaymentPipeline?.length ? "border-red-200" : ""}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  Vendor Payments Due
                  {data?.billsPaymentPipeline?.length ? (
                    <Badge className={`ml-1 ${data.billsOverdueCount > 0 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                      {data.billsPaymentPipeline.length}
                    </Badge>
                  ) : null}
                </CardTitle>
                <Link href="/procurement/bills?payment_status=unpaid" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  View all <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              {data?.billsPaymentTotal ? (
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-xs text-muted-foreground">
                    Outstanding: <span className="font-medium text-foreground">{formatCurrency(data.billsPaymentTotal)}</span>
                  </p>
                  {(data.billsOverdueCount ?? 0) > 0 && (
                    <Badge className="bg-red-100 text-red-700 text-xs gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {data.billsOverdueCount} overdue
                    </Badge>
                  )}
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-4 space-y-3">
                  {[1,2,3].map((i) => <Shimmer key={i} className="h-14 w-full" />)}
                </div>
              ) : !data?.billsPaymentPipeline?.length ? (
                <div className="px-4 py-8 text-center">
                  <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
                  <p className="text-sm font-medium text-green-700">No outstanding payments</p>
                  <p className="text-xs text-muted-foreground mt-1">All approved bills are settled.</p>
                </div>
              ) : (
                <div className="divide-y">
                  {data.billsPaymentPipeline.map((bill) => {
                    const outstanding = bill.total_amount - bill.amount_paid;
                    const isOverdue = bill.due_date && bill.due_date < new Date().toISOString().split("T")[0];
                    return (
                      <Link
                        key={bill.id}
                        href={`/procurement/bills/${bill.id}`}
                        className="flex items-start justify-between px-4 py-3 hover:bg-muted/30 transition-colors group"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm truncate">
                              {bill.procurement_vendors?.name ?? "Unknown Vendor"}
                            </span>
                            <Badge variant="secondary" className={`text-xs ${BILL_PAYMENT_STATUS_COLORS[bill.payment_status] ?? ""}`}>
                              {BILL_PAYMENT_STATUS_LABELS[bill.payment_status] ?? bill.payment_status}
                            </Badge>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                            {bill.purchase_orders?.po_number && (
                              <span className="font-mono">{bill.purchase_orders.po_number}</span>
                            )}
                            {bill.bill_number && <span>· Bill {bill.bill_number}</span>}
                            <span className={`font-semibold ${isOverdue ? "text-red-600" : "text-foreground"}`}>
                              {formatCurrency(outstanding)}
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 ml-3 flex flex-col items-end gap-1">
                          <DueBadge dueDate={bill.due_date} />
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          /* Non-price role: show bills awaiting approval count only */
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                Vendor Bills — Awaiting Approval
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <Shimmer className="h-16 w-full" /> : (
                <div>
                  <p className={`text-3xl font-bold ${(data?.billsPendingCount ?? 0) > 0 ? "text-amber-600" : ""}`}>
                    {data?.billsPendingCount ?? 0}
                  </p>
                  <p className="text-sm text-muted-foreground">bills waiting for review</p>
                  <Link href="/procurement/bills?approval_status=pending" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-3">
                    Review <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Bills awaiting approval — separate card for admin/manager */}
      {canSeePrices && (
        <Card className={data?.billsAwaitingApproval?.length ? "border-amber-200" : ""}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                Bills Awaiting Approval
                {data?.billsAwaitingApproval?.length ? (
                  <Badge className="bg-amber-100 text-amber-700 ml-1">{data.billsAwaitingApproval.length}</Badge>
                ) : null}
              </CardTitle>
              <div className="flex items-center gap-3">
                {data?.billsAwaitingTotal ? (
                  <span className="text-xs text-muted-foreground">
                    Total: <span className="font-medium text-foreground">{formatCurrency(data.billsAwaitingTotal)}</span>
                  </span>
                ) : null}
                <Link href="/procurement/bills?approval_status=pending" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  Review all <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-2">
                {[1,2].map((i) => <Shimmer key={i} className="h-12 w-full" />)}
              </div>
            ) : !data?.billsAwaitingApproval?.length ? (
              <div className="px-4 py-6 text-center">
                <CheckCircle2 className="h-7 w-7 text-green-500 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No bills pending approval.</p>
              </div>
            ) : (
              <div className="divide-y">
                {data.billsAwaitingApproval.map((bill) => {
                  const waitDays = getWaitingDays(bill.created_at);
                  return (
                    <Link
                      key={bill.id}
                      href={`/procurement/bills/${bill.id}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{bill.procurement_vendors?.name ?? "Unknown Vendor"}</span>
                          {waitDays >= 2 && (
                            <Badge className={`text-xs ${waitDays >= 5 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                              Waiting {waitDays}d
                            </Badge>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {bill.purchase_orders?.po_number && <span className="font-mono mr-2">{bill.purchase_orders.po_number}</span>}
                          {bill.bill_number && <span>Bill {bill.bill_number} · </span>}
                          <span className="font-medium text-foreground">{formatCurrency(bill.total_amount)}</span>
                          {bill.invoice_date && <span className="ml-2">Invoiced {formatDate(bill.invoice_date)}</span>}
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Second row: Dept breakdown + PO Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* MRs by department */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              MRs This Month · By Department
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Shimmer key={i} className="h-6 w-full" />)}
              </div>
            ) : data ? (
              <div className="space-y-2">
                {DEPT_ORDER.map((dept) => {
                  const count = data.mrByDepartment[dept] ?? 0;
                  const max = Math.max(...Object.values(data.mrByDepartment), 1);
                  return (
                    <div key={dept} className="flex items-center gap-2">
                      <span className="text-xs w-28 shrink-0 text-muted-foreground">{PROCUREMENT_DEPARTMENT_LABELS[dept] ?? dept}</span>
                      <div className="flex-1 bg-muted rounded-full h-2">
                        <div className="h-2 rounded-full bg-primary transition-all" style={{ width: `${Math.round((count / max) * 100)}%` }} />
                      </div>
                      <span className="text-xs font-medium w-5 text-right">{count}</span>
                    </div>
                  );
                })}
                {Object.keys(data.mrByDepartment).length === 0 && (
                  <p className="text-sm text-muted-foreground">No MRs raised this month.</p>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* PO status breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              Purchase Orders · Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Shimmer key={i} className="h-5 w-full" />)}
              </div>
            ) : data ? (
              <div className="space-y-1.5">
                {Object.entries(data.poByStatus).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between">
                    <Badge variant="secondary" className={`text-xs ${PO_STATUS_COLORS[status] ?? ""}`}>
                      {PO_STATUS_LABELS[status] ?? status}
                    </Badge>
                    <span className="text-sm font-medium">{count}</span>
                  </div>
                ))}
                {Object.keys(data.poByStatus).length === 0 && (
                  <p className="text-sm text-muted-foreground">No purchase orders yet.</p>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent MRs */}
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              Recent Material Requests
            </CardTitle>
            <Link href="/procurement/requests" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Shimmer key={i} className="h-8 w-full" />)}</div>
            ) : data?.recentMrs.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No material requests yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(data?.recentMrs ?? []).map((mr) => (
                    <tr key={mr.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <Link href={`/procurement/requests/${mr.id}`} className="font-mono text-xs font-medium text-primary hover:underline">{mr.pr_number}</Link>
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge variant="secondary" className={`text-xs ${PROCUREMENT_DEPARTMENT_COLORS[mr.department] ?? ""}`}>
                          {PROCUREMENT_DEPARTMENT_LABELS[mr.department] ?? mr.department}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge variant="secondary" className={`text-xs ${PR_STATUS_COLORS[mr.status] ?? ""}`}>
                          {PR_STATUS_LABELS[mr.status] ?? mr.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground hidden sm:table-cell">{formatDate(mr.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Recent POs */}
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              Recent Purchase Orders
            </CardTitle>
            <Link href="/procurement/orders" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Shimmer key={i} className="h-8 w-full" />)}</div>
            ) : data?.recentPos.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No purchase orders yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(data?.recentPos ?? []).map((po) => (
                    <tr key={po.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <Link href={`/procurement/orders/${po.id}`} className="font-mono text-xs font-medium text-primary hover:underline">{po.po_number}</Link>
                      </td>
                      <td className="px-2 py-2.5 text-xs text-muted-foreground max-w-[120px] truncate">{po.procurement_vendors?.name ?? "—"}</td>
                      <td className="px-2 py-2.5">
                        <Badge variant="secondary" className={`text-xs ${PO_STATUS_COLORS[po.status] ?? ""}`}>
                          {PO_STATUS_LABELS[po.status] ?? po.status}
                        </Badge>
                      </td>
                      {canSeePrices && (
                        <td className="px-4 py-2.5 text-right text-xs font-medium hidden sm:table-cell">
                          {po.total_ordered_amount > 0 ? formatCurrency(po.total_ordered_amount) : "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top vendors — admin/manager only */}
      {canSeePrices && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Truck className="h-4 w-4 text-muted-foreground" />
              Top Vendors by Spend · {currentMonth}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Shimmer key={i} className="h-6 w-full" />)}</div>
            ) : data?.topVendors.length === 0 ? (
              <p className="text-sm text-muted-foreground">No PO spend recorded this month.</p>
            ) : (
              <div className="space-y-2">
                {(data?.topVendors ?? []).map((v, idx) => {
                  const max = data?.topVendors[0]?.amount ?? 1;
                  return (
                    <div key={v.name} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-4 shrink-0">{idx + 1}</span>
                      <span className="text-sm font-medium w-44 truncate shrink-0">{v.name}</span>
                      <div className="flex-1 bg-muted rounded-full h-2">
                        <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.round((v.amount / max) * 100)}%` }} />
                      </div>
                      <span className="text-xs font-medium text-right w-24 shrink-0">{formatCurrency(v.amount)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

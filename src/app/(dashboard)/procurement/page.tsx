"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ClipboardList, Package, Receipt, TrendingUp, TrendingDown,
  AlertCircle, CheckCircle2, Clock, BarChart3, ArrowRight,
  IndianRupee, ShoppingCart, Truck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import {
  PR_STATUS_LABELS, PR_STATUS_COLORS,
  PO_STATUS_LABELS, PO_STATUS_COLORS,
  PROCUREMENT_DEPARTMENT_LABELS, PROCUREMENT_DEPARTMENT_COLORS,
} from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";

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

const DEPT_ORDER = ["pantry", "maintenance", "administration", "asset"];

export default function ProcurementDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState("");

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((j) => setUserRole(j.role ?? ""));
    fetch("/api/procurement/dashboard")
      .then((r) => r.json())
      .then((j) => { if (j.data) setData(j.data); })
      .finally(() => setLoading(false));
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
        <Button variant="outline" size="sm" onClick={() => {
          setLoading(true);
          fetch("/api/procurement/dashboard").then((r) => r.json()).then((j) => { if (j.data) setData(j.data); }).finally(() => setLoading(false));
        }}>
          Refresh
        </Button>
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

      {/* Second row: Bills alert + Department breakdown + PO Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Pending bills */}
        {canSeePrices && (
          <Card className={data?.billsPendingCount ? "border-red-200" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                Vendor Bills
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Shimmer className="h-16 w-full" />
              ) : data ? (
                <div className="space-y-1">
                  <p className={`text-3xl font-bold ${data.billsPendingCount > 0 ? "text-red-600" : ""}`}>
                    {data.billsPendingCount}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    pending approval{data.billsPendingCount > 0 && canSeePrices ? ` · ${formatCurrency(data.billsPendingValue)}` : ""}
                  </p>
                  <Link href="/procurement/bills?status=pending" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2">
                    Review bills <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}

        {/* MRs by department */}
        <Card className={canSeePrices ? "" : "md:col-span-2"}>
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
                      <span className="text-xs w-28 shrink-0 text-muted-foreground">
                        {PROCUREMENT_DEPARTMENT_LABELS[dept] ?? dept}
                      </span>
                      <div className="flex-1 bg-muted rounded-full h-2">
                        <div
                          className="h-2 rounded-full bg-primary transition-all"
                          style={{ width: `${Math.round((count / max) * 100)}%` }}
                        />
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
        {canSeePrices && (
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
                  {Object.entries(data.poByStatus)
                    .sort((a, b) => b[1] - a[1])
                    .map(([status, count]) => (
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
        )}
      </div>

      {/* Third row: Recent MRs + Recent POs */}
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
              <div className="p-4 space-y-3">
                {Array.from({ length: 5 }).map((_, i) => <Shimmer key={i} className="h-8 w-full" />)}
              </div>
            ) : data?.recentMrs.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No material requests yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(data?.recentMrs ?? []).map((mr) => (
                    <tr key={mr.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <Link href={`/procurement/requests/${mr.id}`} className="font-mono text-xs font-medium text-primary hover:underline">
                          {mr.pr_number}
                        </Link>
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
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground hidden sm:table-cell">
                        {formatDate(mr.created_at)}
                      </td>
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
              <div className="p-4 space-y-3">
                {Array.from({ length: 5 }).map((_, i) => <Shimmer key={i} className="h-8 w-full" />)}
              </div>
            ) : data?.recentPos.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No purchase orders yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(data?.recentPos ?? []).map((po) => (
                    <tr key={po.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <Link href={`/procurement/orders/${po.id}`} className="font-mono text-xs font-medium text-primary hover:underline">
                          {po.po_number}
                        </Link>
                      </td>
                      <td className="px-2 py-2.5 text-xs text-muted-foreground max-w-[120px] truncate">
                        {po.procurement_vendors?.name ?? "—"}
                      </td>
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
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Shimmer key={i} className="h-6 w-full" />)}
              </div>
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
                        <div
                          className="h-2 rounded-full bg-primary"
                          style={{ width: `${Math.round((v.amount / max) * 100)}%` }}
                        />
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

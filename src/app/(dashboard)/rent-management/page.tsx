"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Building2, IndianRupee, AlertTriangle, Clock,
  TrendingUp, ChevronRight, Plus, ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  LEASE_PAYMENT_STATUS_COLORS, LEASE_PAYMENT_STATUS_LABELS,
} from "@/lib/constants";
import type { PropertyLease, LeasePayment } from "@/types";

interface DashboardData {
  activeLeases: number;
  totalMonthlyRent: number;
  paymentsDueThisMonth: number;
  paymentsOverdue: number;
  nextEscalationDate: string | null;
  upcomingPayments: (LeasePayment & { lease: PropertyLease })[];
  overduePayments: (LeasePayment & { lease: PropertyLease })[];
}

export default function RentManagementDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => setUserRole(d.role));
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [leasesRes] = await Promise.all([
          fetch("/api/rent-management/leases?status=active"),
        ]);

        const leasesJson = leasesRes.ok ? await leasesRes.json() : { data: [] };
        const leases: PropertyLease[] = leasesJson.data || [];

        const totalRent = leases.reduce((sum, l) => sum + l.base_rent_amount, 0);
        const nextEsc = leases
          .filter((l) => l.next_escalation_date)
          .map((l) => l.next_escalation_date!)
          .sort()[0] || null;

        // Fetch payments due/overdue
        const [dueRes, overdueRes] = await Promise.all([
          fetch("/api/rent-management/payments?status=pending&due_days=30"),
          fetch("/api/rent-management/payments?status=overdue"),
        ]);

        const dueJson = dueRes.ok ? await dueRes.json() : { data: [] };
        const overdueJson = overdueRes.ok ? await overdueRes.json() : { data: [] };

        const upcoming = (dueJson.data || []).slice(0, 5);
        const overdue = overdueJson.data || [];

        setData({
          activeLeases: leases.length,
          totalMonthlyRent: totalRent,
          paymentsDueThisMonth: upcoming.length,
          paymentsOverdue: overdue.length,
          nextEscalationDate: nextEsc,
          upcomingPayments: upcoming,
          overduePayments: overdue.slice(0, 5),
        });
      } catch {
        setData(null);
      }
      setLoading(false);
    }
    load();
  }, []);

  const isAdmin = userRole === "admin";

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="h-8 w-64 bg-muted animate-pulse rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Rent Management</h1>
          <p className="text-sm text-muted-foreground">Manage facility leases, payments, and landlord relationships</p>
        </div>
        {isAdmin && (
          <Button asChild>
            <Link href="/rent-management/leases/new">
              <Plus className="h-4 w-4 mr-2" />
              New Lease
            </Link>
          </Button>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">Active Leases</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.activeLeases ?? 0}</div>
            <p className="text-xs text-muted-foreground">Across all locations</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">Monthly Rent Outflow</CardTitle>
            <IndianRupee className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(data?.totalMonthlyRent ?? 0)}</div>
            <p className="text-xs text-muted-foreground">Total base rent</p>
          </CardContent>
        </Card>

        <Card className={data?.paymentsOverdue ? "border-red-200 bg-red-50/30" : ""}>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">Overdue Payments</CardTitle>
            <AlertTriangle className={`h-4 w-4 ${data?.paymentsOverdue ? "text-red-500" : "text-muted-foreground"}`} />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${data?.paymentsOverdue ? "text-red-600" : ""}`}>
              {data?.paymentsOverdue ?? 0}
            </div>
            <p className="text-xs text-muted-foreground">Need immediate attention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">Next Escalation</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold">
              {data?.nextEscalationDate ? formatDate(data.nextEscalationDate) : "—"}
            </div>
            <p className="text-xs text-muted-foreground">Earliest upcoming</p>
          </CardContent>
        </Card>
      </div>

      {/* Overdue alert */}
      {(data?.overduePayments?.length ?? 0) > 0 && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              <span className="font-medium text-red-800">Overdue Payments</span>
            </div>
            <div className="space-y-2">
              {data!.overduePayments.map((p) => (
                <div key={p.id} className="flex items-center justify-between text-sm">
                  <span className="text-red-700">
                    {p.lease?.location?.name ?? "Unknown"} — {p.payment_month}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-red-700">{formatCurrency(p.gross_rent_amount)}</span>
                    <Link href={`/rent-management/leases/${p.lease_id}`} className="text-red-600 hover:underline">
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upcoming payments */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Upcoming Payments (30 days)</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {(data?.upcomingPayments?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No payments due in next 30 days</p>
            ) : (
              <div className="space-y-3">
                {data!.upcomingPayments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{p.lease?.location?.name ?? "Unknown"}</p>
                      <p className="text-xs text-muted-foreground">Due {formatDate(p.due_date)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{formatCurrency(p.gross_rent_amount)}</span>
                      <Badge className={LEASE_PAYMENT_STATUS_COLORS[p.status]}>
                        {LEASE_PAYMENT_STATUS_LABELS[p.status]}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick links */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick Access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {[
              { href: "/rent-management/leases", label: "All Leases", icon: Building2 },
              { href: "/rent-management/landlords", label: "Landlords", icon: Building2 },
            ].map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{label}</span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

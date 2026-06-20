"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import {
  TrendingUp,
  Receipt,
  Package,
  Wrench,
  Building2,
  Cpu,
  Loader2,
} from "lucide-react";

interface WeekInReviewData {
  sales: {
    leads_created: number;
    proposals_sent: number;
    proposals_accepted: number;
    contracts_activated: number;
    contracts_expiring_soon: number;
  };
  billing: {
    statements_generated: number;
    payments_collected: number;
    overdue_statements: number;
    vendor_bills_approved: number;
    vendor_payments_total: number;
  };
  procurement: {
    prs_raised: number;
    pos_created: number;
    deliveries_confirmed: number;
    bills_pending_approval: number;
  };
  facility: {
    issues_opened: number;
    issues_resolved: number;
    issues_open: number;
    bookings: number;
  };
  spaces: {
    total_capacity: number;
    occupied: number;
    vacated: number;
    new_assignments: number;
    occupancy_pct: number;
  };
  assets: {
    warranties_expiring: number;
    assets_added: number;
    lifecycle_events: number;
    documents_uploaded: number;
  };
}

function Row({
  label,
  value,
  tone,
  badge,
}: {
  label: string;
  value: string | number;
  tone?: "green" | "amber" | "red";
  badge?: string;
}) {
  const toneClass =
    tone === "green"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "amber"
      ? "text-amber-700 dark:text-amber-400"
      : tone === "red"
      ? "text-red-700 dark:text-red-400"
      : "text-foreground";

  const badgeBg =
    badge === undefined
      ? ""
      : tone === "amber"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      : tone === "red"
      ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
      : "bg-muted text-muted-foreground";

  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium flex items-center gap-1.5 ${toneClass}`}>
        {value}
        {badge !== undefined && (
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${badgeBg}`}>
            {badge}
          </span>
        )}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 border-t border-border/50" />;
}

export function WeekInReviewWidget() {
  const [data, setData] = useState<WeekInReviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/week-in-review")
      .then((r) => r.json())
      .then((json) => setData(json.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateRange = `${sevenDaysAgo.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${now.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Last 7 days</h2>
        <span className="text-xs text-muted-foreground">{dateRange}</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !data ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Could not load weekly summary.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Sales */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <TrendingUp className="h-4 w-4" />
                Sales
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <Row label="New leads" value={data.sales.leads_created} />
              <Row label="Proposals sent" value={data.sales.proposals_sent} />
              <Row
                label="Proposals accepted"
                value={data.sales.proposals_accepted}
                tone={data.sales.proposals_accepted > 0 ? "green" : undefined}
              />
              <Row
                label="Contracts activated"
                value={data.sales.contracts_activated}
                tone={data.sales.contracts_activated > 0 ? "green" : undefined}
              />
              <Divider />
              <Row
                label="Expiring in 30 days"
                value={data.sales.contracts_expiring_soon}
                tone={data.sales.contracts_expiring_soon > 0 ? "amber" : undefined}
                badge={data.sales.contracts_expiring_soon > 0 ? "review" : undefined}
              />
            </CardContent>
          </Card>

          {/* Billing & Finance */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <Receipt className="h-4 w-4" />
                Billing & finance
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <Row label="Invoices generated" value={data.billing.statements_generated} />
              <Row
                label="Payments collected"
                value={formatCurrency(data.billing.payments_collected)}
                tone={data.billing.payments_collected > 0 ? "green" : undefined}
              />
              <Row
                label="Overdue statements"
                value={data.billing.overdue_statements}
                tone={data.billing.overdue_statements > 0 ? "red" : undefined}
                badge={data.billing.overdue_statements > 0 ? "overdue" : undefined}
              />
              <Divider />
              <Row label="Vendor bills approved" value={data.billing.vendor_bills_approved} />
              <Row
                label="Vendor payments made"
                value={formatCurrency(data.billing.vendor_payments_total)}
              />
            </CardContent>
          </Card>

          {/* Procurement */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <Package className="h-4 w-4" />
                Procurement
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <Row label="Material requests raised" value={data.procurement.prs_raised} />
              <Row label="POs created" value={data.procurement.pos_created} />
              <Row
                label="Deliveries confirmed"
                value={data.procurement.deliveries_confirmed}
                tone={data.procurement.deliveries_confirmed > 0 ? "green" : undefined}
              />
              <Divider />
              <Row
                label="Bills pending approval"
                value={data.procurement.bills_pending_approval}
                tone={data.procurement.bills_pending_approval > 0 ? "amber" : undefined}
                badge={data.procurement.bills_pending_approval > 0 ? "pending" : undefined}
              />
            </CardContent>
          </Card>

          {/* Facility */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <Wrench className="h-4 w-4" />
                Facility
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <Row label="Tickets opened" value={data.facility.issues_opened} />
              <Row
                label="Tickets resolved"
                value={data.facility.issues_resolved}
                tone={data.facility.issues_resolved > 0 ? "green" : undefined}
              />
              <Row
                label="Currently open"
                value={data.facility.issues_open}
                tone={data.facility.issues_open > 0 ? "red" : undefined}
              />
              <Divider />
              <Row label="Bookings this week" value={data.facility.bookings} />
            </CardContent>
          </Card>

          {/* Spaces */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <Building2 className="h-4 w-4" />
                Spaces
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <Row label="Total seats" value={data.spaces.total_capacity} />
              <Row label="Occupied" value={data.spaces.occupied} />
              <Row label="Vacated this week" value={data.spaces.vacated} />
              <Row
                label="New assignments"
                value={data.spaces.new_assignments}
                tone={data.spaces.new_assignments > 0 ? "green" : undefined}
              />
              <Divider />
              <div className="mt-1">
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>Occupancy</span>
                  <span className="font-medium text-foreground">{data.spaces.occupancy_pct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{ width: `${data.spaces.occupancy_pct}%` }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Assets */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <Cpu className="h-4 w-4" />
                Assets & issues
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <Row
                label="Warranties expiring (30d)"
                value={data.assets.warranties_expiring}
                tone={data.assets.warranties_expiring > 0 ? "amber" : undefined}
                badge={data.assets.warranties_expiring > 0 ? "soon" : undefined}
              />
              <Row
                label="Assets added"
                value={data.assets.assets_added}
                tone={data.assets.assets_added > 0 ? "green" : undefined}
              />
              <Divider />
              <Row label="Lifecycle events logged" value={data.assets.lifecycle_events} />
              <Row label="Documents uploaded" value={data.assets.documents_uploaded} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

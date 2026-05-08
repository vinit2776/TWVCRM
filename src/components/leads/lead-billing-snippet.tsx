"use client";

/**
 * LeadBillingSnippet — compact "money this lead has paid us" snapshot
 * for the lead profile, designed to slot in above the activity timeline.
 *
 * Shows three KPIs (total · transactions · avg) with a period toggle
 * (Lifetime / This FY) and a small line graph of monthly revenue.
 * Designed to be at-a-glance: 60-second answer to "is this a serious
 * customer?"
 *
 * Data source: GET /api/leads/[id]/billing-summary which aggregates
 * verified booking_payments + contract_payments. No client-side math.
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, IndianRupee, Hash, Loader2 } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { formatCurrency, formatDate } from "@/lib/utils";

interface BillingSummary {
  period: "lifetime" | "fy_current";
  total_revenue: number;
  transaction_count: number;
  avg_transaction: number;
  first_paid_at: string | null;
  last_paid_at: string | null;
  by_source: { bookings: number; contracts: number };
  monthly: { month: string; amount: number }[];
}

type Period = "lifetime" | "fy_current";

interface Props {
  leadId: string;
}

export function LeadBillingSnippet({ leadId }: Props) {
  const [period, setPeriod] = useState<Period>("lifetime");
  const [data, setData] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/leads/${leadId}/billing-summary?period=${period}`)
      .then((r) => r.json())
      .then((j) => setData(j.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [leadId, period]);

  // Format a YYYY-MM month key as "Apr 26" for the X-axis
  const formatMonthLabel = (monthKey: string): string => {
    const [year, month] = monthKey.split("-").map(Number);
    const d = new Date(year, month - 1, 1);
    return d.toLocaleString("en-US", { month: "short" }) + " " + String(year).slice(-2);
  };

  // Indian financial year label for the toggle (e.g., "FY 26-27")
  const fyLabel = (() => {
    const now = new Date();
    const m = now.getMonth();
    const startYear = m >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `FY ${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
  })();

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Header — title + period toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold">Billing snapshot</h3>
          </div>
          <div className="flex rounded-md border overflow-hidden text-xs">
            {(
              [
                { v: "lifetime",   label: "Lifetime" },
                { v: "fy_current", label: fyLabel    },
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setPeriod(opt.v)}
                className={`px-3 py-1 transition-colors ${
                  period === opt.v
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-xs text-muted-foreground py-6 text-center flex items-center justify-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : !data || data.transaction_count === 0 ? (
          <p className="text-xs text-muted-foreground italic text-center py-4">
            No payments recorded for this customer{period === "fy_current" ? ` in ${fyLabel}` : ""}.
          </p>
        ) : (
          <>
            {/* KPI tiles */}
            <div className="grid grid-cols-3 gap-2">
              <Tile
                icon={<IndianRupee className="h-3.5 w-3.5" />}
                label="Total"
                value={formatCurrency(data.total_revenue)}
                tone="emerald"
              />
              <Tile
                icon={<Hash className="h-3.5 w-3.5" />}
                label="Transactions"
                value={String(data.transaction_count)}
                tone="blue"
              />
              <Tile
                icon={<TrendingUp className="h-3.5 w-3.5" />}
                label="Avg"
                value={formatCurrency(data.avg_transaction)}
                tone="slate"
              />
            </div>

            {/* Line graph — monthly revenue */}
            {data.monthly.length > 1 && (
              <div className="h-36 -mx-1">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={data.monthly.map((m) => ({
                      month: formatMonthLabel(m.month),
                      amount: m.amount,
                    }))}
                    margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10, fill: "#6b7280" }}
                      tickLine={false}
                      axisLine={{ stroke: "#e5e7eb" }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "#6b7280" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                      formatter={(value) => [formatCurrency(Number(value) || 0), "Revenue"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="amount"
                      stroke="#015E65"
                      strokeWidth={2}
                      dot={{ r: 2.5, fill: "#015E65" }}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Footer — source breakdown + first/last */}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t">
              <span>
                Bookings: <strong className="text-foreground">{formatCurrency(data.by_source.bookings)}</strong>
                {data.by_source.contracts > 0 && (
                  <> · Contract: <strong className="text-foreground">{formatCurrency(data.by_source.contracts)}</strong></>
                )}
              </span>
              {data.first_paid_at && data.last_paid_at && (
                <span>
                  {formatDate(data.first_paid_at)} → {formatDate(data.last_paid_at)}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({
  icon, label, value, tone,
}: { icon: React.ReactNode; label: string; value: string; tone: "emerald" | "blue" | "slate" }) {
  const tones = {
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
    blue:    "bg-blue-50    text-blue-900    border-blue-200",
    slate:   "bg-slate-50   text-slate-900   border-slate-200",
  };
  return (
    <div className={`rounded-md border px-3 py-2 ${tones[tone]}`}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-70">
        {icon} {label}
      </div>
      <div className="text-base font-bold mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

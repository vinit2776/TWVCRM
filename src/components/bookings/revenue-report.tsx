"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, TrendingUp, PieChart as PieChartIcon, AlertTriangle } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid } from "recharts";
import { formatCurrency } from "@/lib/utils";
import { BOOKING_CUSTOMER_TYPE_LABELS } from "@/lib/constants";

interface RevenueData {
  period: { from: string; to: string };
  total_revenue: number;
  total_bookings: number;
  cancellation_rate: number;
  no_show_rate: number;
  by_payment_mode: { mode: string; amount: number }[];
  by_customer_type: { type: string; amount: number; count: number }[];
  by_space: { space_name: string; amount: number; count: number }[];
  trend: { month: string; revenue: number; bookings: number }[];
}

const PIE_COLORS = ["#015E65", "#00AE6C", "#e67e22", "#9b59b6", "#3498db"];
const PAYMENT_LABELS: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", razorpay: "Online", bank_transfer: "Bank Transfer" };

export function RevenueReport({ locationId }: { locationId?: string }) {
  const [data, setData] = useState<RevenueData | null>(null);
  const [loading, setLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 6);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo] = useState(new Date().toISOString().split("T")[0]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (locationId) params.set("location_id", locationId);

    fetch(`/api/bookings/analytics/revenue?${params}`)
      .then(r => r.json())
      .then(json => { if (json.data) setData(json.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, locationId]);

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  if (!data) return <p className="text-center text-gray-500 py-8">No data available</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div>
          <Label className="text-xs">From</Label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-40" />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-40" />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-[#015E65]">{formatCurrency(data.total_revenue)}</div>
            <div className="text-sm text-gray-500">Total Revenue</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold">{data.total_bookings}</div>
            <div className="text-sm text-gray-500">Total Bookings</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-red-500">{data.cancellation_rate}%</div>
            <div className="text-sm text-gray-500">Cancellation Rate</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-orange-500">{data.no_show_rate}%</div>
            <div className="text-sm text-gray-500 flex items-center justify-center gap-1"><AlertTriangle className="w-3 h-3" /> No-Show Rate</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by Payment Mode */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><PieChartIcon className="w-4 h-4" /> By Payment Mode</CardTitle>
          </CardHeader>
          <CardContent>
            {data.by_payment_mode.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No payment data</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={data.by_payment_mode.map(p => ({ ...p, name: PAYMENT_LABELS[p.mode] || p.mode }))} dataKey="amount" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>
                    {data.by_payment_mode.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  <Tooltip formatter={(value: any) => formatCurrency(Number(value))} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Revenue by Customer Type */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><PieChartIcon className="w-4 h-4" /> By Customer Type</CardTitle>
          </CardHeader>
          <CardContent>
            {data.by_customer_type.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={data.by_customer_type.map(c => ({ ...c, name: BOOKING_CUSTOMER_TYPE_LABELS[c.type] || c.type }))} dataKey="amount" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>
                    {data.by_customer_type.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  <Tooltip formatter={(value: any) => formatCurrency(Number(value))} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Monthly Trend */}
      {data.trend.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="w-4 h-4" /> Monthly Revenue Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={data.trend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`} />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip formatter={(value: any, name: any) => [name === "revenue" ? formatCurrency(Number(value)) : value, name === "revenue" ? "Revenue" : "Bookings"]} />
                <Line type="monotone" dataKey="revenue" stroke="#015E65" strokeWidth={2} dot={{ fill: "#015E65" }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

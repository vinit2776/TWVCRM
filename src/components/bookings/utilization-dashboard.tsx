"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, BarChart3 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { formatCurrency } from "@/lib/utils";

interface UtilizationData {
  space_id: string;
  space_name: string;
  location_name: string;
  available_hours: number;
  booked_hours: number;
  utilization_pct: number;
  revenue: number;
  total_bookings: number;
  peak_hours: { hour: number; count: number }[];
}

const COLORS = ["#015E65", "#00AE6C", "#0088cc", "#e67e22", "#9b59b6", "#e74c3c"];

export function UtilizationDashboard({ locationId }: { locationId?: string }) {
  const [data, setData] = useState<UtilizationData[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo] = useState(new Date().toISOString().split("T")[0]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (locationId) params.set("location_id", locationId);

    fetch(`/api/bookings/analytics/utilization?${params}`)
      .then(r => r.json())
      .then(json => { if (json.data) setData(json.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, locationId]);

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  const chartData = data.map(d => ({
    name: d.space_name,
    utilization: d.utilization_pct,
    revenue: d.revenue,
    bookings: d.total_bookings,
  }));

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

      {/* Utilization Bar Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="w-5 h-5" /> Room Utilization (%)</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No data available</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="%" />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip formatter={(value: any) => [`${Number(value).toFixed(1)}%`, "Utilization"]} />
                <Bar dataKey="utilization" radius={[4, 4, 0, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Room Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.map((room, i) => (
          <Card key={room.space_id}>
            <CardContent className="p-4">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h4 className="font-semibold">{room.space_name}</h4>
                  <p className="text-xs text-gray-500">{room.location_name}</p>
                </div>
                <div
                  className="text-lg font-bold"
                  style={{ color: COLORS[i % COLORS.length] }}
                >
                  {room.utilization_pct.toFixed(0)}%
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <div className="text-gray-500 text-xs">Bookings</div>
                  <div className="font-semibold">{room.total_bookings}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Booked Hrs</div>
                  <div className="font-semibold">{room.booked_hours}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Revenue</div>
                  <div className="font-semibold">{formatCurrency(room.revenue)}</div>
                </div>
              </div>
              {room.peak_hours.length > 0 && (
                <p className="text-xs text-gray-400 mt-2">
                  Peak: {room.peak_hours.slice(0, 3).map(p => `${p.hour}:00`).join(", ")}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

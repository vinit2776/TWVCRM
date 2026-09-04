"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface TrendPoint {
  date: string;
  count: number;
}

export function DailyTrendChart({ trend }: { trend: TrendPoint[] }) {
  const interval = trend.length <= 10 ? 0 : trend.length <= 21 ? 2 : trend.length <= 45 ? 6 : 13;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={trend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10 }}
          interval={interval}
          angle={trend.length > 14 ? -35 : 0}
          textAnchor={trend.length > 14 ? "end" : "middle"}
          height={trend.length > 14 ? 40 : 20}
        />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip formatter={(v) => [`${v} question${v === 1 ? "" : "s"}`, "Asked"]} />
        <Bar dataKey="count" fill="#015e65" radius={[3, 3, 0, 0]} name="Questions" />
      </BarChart>
    </ResponsiveContainer>
  );
}

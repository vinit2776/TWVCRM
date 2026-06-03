"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface FootfallPoint {
  date: string;
  label: string;
  count: number;
}

interface DowPoint {
  day: string;
  entries: number;
}

export function FootfallChart({
  footfall,
  ffInterval,
}: {
  footfall: FootfallPoint[];
  ffInterval: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={footfall} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10 }}
          interval={ffInterval}
          angle={footfall.length > 14 ? -35 : 0}
          textAnchor={footfall.length > 14 ? "end" : "middle"}
          height={footfall.length > 14 ? 40 : 20}
        />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => [`${v} entries`, "Footfall"]} />
        <Bar dataKey="count" fill="#0ea5e9" radius={[3, 3, 0, 0]} name="Entries" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DowChart({ dowData }: { dowData: DowPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={dowData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => [`${v} entries`, "Total"]} />
        <Bar dataKey="entries" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

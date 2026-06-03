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

interface SevenDayPoint {
  label: string;
  IN: number;
  OUT: number;
  DENIED: number;
}

export default function CosecDeviceChart({ data }: { data: SevenDayPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="IN" fill="#00AE6C" radius={[2, 2, 0, 0]} name="Entry" />
        <Bar dataKey="OUT" fill="#0284c7" radius={[2, 2, 0, 0]} name="Exit" />
        <Bar dataKey="DENIED" fill="#ef4444" radius={[2, 2, 0, 0]} name="Denied" />
      </BarChart>
    </ResponsiveContainer>
  );
}

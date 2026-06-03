"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface StatsPoint {
  timestamp: string;
  label: string;
  wlan_users: number;
  wan_tx_bytes: number;
  wan_rx_bytes: number;
  wlan_bytes: number;
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function VisitorsChart({ stats }: { stats: StatsPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <AreaChart data={stats} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <defs>
          <linearGradient id="visitorGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Area
          type="monotone"
          dataKey="wlan_users"
          name="WiFi Users"
          stroke="#6366f1"
          fill="url(#visitorGrad)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function BandwidthChart({ stats }: { stats: StatsPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={stats} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <defs>
          <linearGradient id="txGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="rxGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis
          tickFormatter={(v: number) => fmtBytes(v)}
          tick={{ fontSize: 10 }}
          width={65}
        />
        <Tooltip
          formatter={(v: number | string | undefined) =>
            v != null ? fmtBytes(Number(v)) : "—"
          }
        />
        <Legend />
        <Area
          type="monotone"
          dataKey="wan_tx_bytes"
          name="Upload"
          stroke="#10b981"
          fill="url(#txGrad)"
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="wan_rx_bytes"
          name="Download"
          stroke="#6366f1"
          fill="url(#rxGrad)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

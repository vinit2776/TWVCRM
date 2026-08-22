"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceArea,
} from "recharts";
import { formatCurrency } from "@/lib/utils";
import type { CenterSummary, TrendMetric, TrendSeries } from "./types";

// Fixed hue order, matching the mockup's categorical palette — a center
// always gets the same color regardless of which others are toggled off.
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"];

function formatTrendValue(metric: TrendMetric, value: number | undefined) {
  const v = value ?? 0;
  return metric === "occ" ? `${v}%` : formatCurrency(v);
}

function formatMoney(value: number | undefined) {
  return formatCurrency(value ?? 0);
}

/** Per-center monthly trend, one call per metric tab (Sales/Collections/Occupancy). */
export function TrendChart({
  series,
  metric,
  highlightMonths,
}: {
  series: TrendSeries[];
  metric: TrendMetric;
  /** Month keys ("YYYY-MM") within the currently-selected KPI period, shaded on the chart. */
  highlightMonths: string[];
}) {
  if (series.length === 0 || series[0].points.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No data for the selected centers.</p>;
  }

  const months = series[0].points.map((p) => p.month);
  const data = months.map((month, i) => {
    const row: Record<string, string | number> = { month };
    for (const s of series) row[s.location_name] = s.points[i]?.value ?? 0;
    return row;
  });

  const highlightStart = highlightMonths.length > 0 ? highlightMonths[0] : null;
  const highlightEnd = highlightMonths.length > 0 ? highlightMonths[highlightMonths.length - 1] : null;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} interval={0} />
        <YAxis
          tick={{ fontSize: 11 }}
          tickFormatter={(v) => (metric === "occ" ? `${v}%` : formatCurrency(v))}
          width={metric === "occ" ? 40 : 70}
        />
        <Tooltip formatter={(v) => formatTrendValue(metric, v as number | undefined)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {highlightStart && highlightEnd && (
          <ReferenceArea x1={highlightStart} x2={highlightEnd} fill="#2a78d6" fillOpacity={0.06} />
        )}
        {series.map((s, i) => (
          <Bar
            key={s.location_id}
            dataKey={s.location_name}
            fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            radius={[3, 3, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Billed vs collected for the selected period, one grouped pair per center. */
export function BilledCollectedChart({ centers }: { centers: CenterSummary[] }) {
  if (centers.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No data for the selected centers.</p>;
  }

  const data = centers.map((c) => ({
    name: c.location_name,
    Billed: c.billed,
    Collected: c.collections,
  }));

  // Recharts silently drops overlapping tick labels past a handful of
  // categories — angle them (matching FootfallChart's precedent in
  // access-analytics-charts.tsx) so every center stays legible instead of
  // only the 2 that happened to fit horizontally.
  const dense = data.length > 5;

  return (
    <ResponsiveContainer width="100%" height={dense ? 340 : 300}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: dense ? 50 : 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10 }}
          interval={0}
          angle={dense ? -35 : 0}
          textAnchor={dense ? "end" : "middle"}
          height={dense ? 60 : 20}
        />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v)} width={70} />
        <Tooltip formatter={(v) => formatMoney(v as number | undefined)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="Billed" fill="#2a78d6" radius={[3, 3, 0, 0]} />
        <Bar dataKey="Collected" fill="#1baf7a" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

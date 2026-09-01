"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/utils";

interface ProjectionTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number }>;
  label?: string;
}

const CONFIRMED_COLOR = "#2a78d6";
const RENEWED_COLOR = "#c8781f";

function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} '${String(y).slice(2)}`;
}

function ProjectionTooltip({ active, payload, label }: ProjectionTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const confirmed = payload.find((p) => p.dataKey === "Confirmed")?.value ?? 0;
  const renewed = payload.find((p) => p.dataKey === "If renewed")?.value ?? 0;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-md">
      <div className="font-semibold">{monthLabel(label ?? "")}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-sm" style={{ background: CONFIRMED_COLOR }} />
        Confirmed: {formatCurrency(confirmed)}
      </div>
      {renewed > 0 && (
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm border" style={{ borderColor: RENEWED_COLOR, background: `${RENEWED_COLOR}33` }} />
          If renewed: +{formatCurrency(renewed)}
        </div>
      )}
      <div className="mt-1 border-t pt-1 font-semibold">
        Total: {formatCurrency(confirmed + renewed)}
      </div>
    </div>
  );
}

/** Stacked monthly bars: confirmed (solid) + if-renewed (hatched, on top) for a financial year. */
export function ProjectionChart({
  months,
  confirmed,
  ifRenewed,
}: {
  months: string[];
  confirmed: number[];
  ifRenewed: number[];
}) {
  if (months.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No data for the selected centers.</p>;
  }

  const data = months.map((month, i) => ({
    month,
    Confirmed: confirmed[i] ?? 0,
    "If renewed": ifRenewed[i] ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <pattern id="projHatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill={`${RENEWED_COLOR}22`} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={RENEWED_COLOR} strokeWidth="2" opacity="0.6" />
          </pattern>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} interval={0} />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v)} width={70} />
        <Tooltip content={<ProjectionTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="Confirmed" stackId="rev" fill={CONFIRMED_COLOR} radius={[0, 0, 0, 0]} />
        <Bar dataKey="If renewed" stackId="rev" fill="url(#projHatch)" stroke={RENEWED_COLOR} strokeWidth={1} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

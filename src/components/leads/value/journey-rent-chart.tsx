"use client";

import { diffDays, type Journey } from "@/lib/customer-value/journey";
import { formatCurrency, formatDate } from "@/lib/utils";

interface JourneyRentChartProps {
  journey: Journey;
}

const W = 640;
const H = 200;
const PAD = { left: 64, right: 16, top: 16, bottom: 28 };

/**
 * Rent over time as a step line, with a hollow marker wherever a renewal asked
 * for more than was agreed. Plots rent per seat when every step knows its seat
 * count, otherwise the contract's monthly rent. Plain SVG.
 */
export function JourneyRentChart({ journey }: JourneyRentChartProps) {
  const steps = journey.rentSteps;
  if (steps.length === 0) return null;

  const usePerSeat = steps.every((s) => s.perSeat !== null);
  const value = (s: (typeof steps)[number]) => (usePerSeat ? (s.perSeat as number) : s.monthlyRent);

  // Hollow "asked" markers: where the parent's clause would have put the rent.
  const asks = journey.escalations.flatMap((e) => {
    if (e.askedPct === null || e.outcome === "accepted") return [];
    const before = [...steps].reverse().find((s) => s.contractNumber === e.parentContractNumber);
    if (!before) return [];
    return [{ date: e.date, value: value(before) * (1 + e.askedPct / 100), pct: e.askedPct }];
  });

  const values = [...steps.map(value), ...asks.map((a) => a.value)];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = rawMax - rawMin || rawMax * 0.1 || 1;
  const yMin = Math.max(0, rawMin - spread * 0.25);
  const yMax = rawMax + spread * 0.25;

  const start = steps[0].from;
  const end = steps[steps.length - 1].to;
  const totalDays = Math.max(1, diffDays(start, end));
  const x = (d: string) => PAD.left + (diffDays(start, d) / totalDays) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  let path = "";
  steps.forEach((s, i) => {
    const v = y(value(s));
    path += i === 0 ? `M${x(s.from)},${v}` : ` L${x(s.from)},${v}`;
    path += ` L${x(s.to)},${v}`;
  });

  const label = usePerSeat ? "Rent per seat per month" : "Monthly rent";

  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">{label} (before tax)</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} over time`}>
        {[yMin + (yMax - yMin) * 0.1, (yMin + yMax) / 2, yMax - (yMax - yMin) * 0.1].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.6}>
              {formatCurrency(Math.round(v))}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#059669" strokeWidth={2.5} strokeLinejoin="round" />
        {asks.map((a) => (
          <g key={a.date}>
            <circle cx={x(a.date)} cy={y(a.value)} r={5} fill="none" stroke="#d97706" strokeWidth={2} />
            <text x={x(a.date) + 9} y={y(a.value) + 4} fontSize={11} fill="#b45309">
              Asked +{a.pct}%
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 8} fontSize={11} fill="currentColor" fillOpacity={0.6}>
          {formatDate(start)}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.6}>
          {formatDate(end)}
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-emerald-600" /> Agreed
        </span>
        {asks.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-600" /> Asked, not achieved
          </span>
        )}
      </div>
    </div>
  );
}

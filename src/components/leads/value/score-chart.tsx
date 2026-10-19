"use client";

import type { SeriesPoint } from "@/lib/customer-value/summary-view";
import { formatDate } from "@/lib/utils";

const W = 640;
const H = 170;
const PAD = { left: 34, right: 12, top: 12, bottom: 24 };
/** Tier boundaries from the default scoring settings, drawn as faint guides when they fall in view. */
const GUIDES = [75, 60, 40];

/** A vertical range that fits the data with some room, at least 30 points tall, inside 0 to 100. */
export function chartRange(values: number[]): { lo: number; hi: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  let lo = Math.max(0, Math.floor(min / 10) * 10 - 10);
  let hi = Math.min(100, Math.ceil(max / 10) * 10 + 10);
  if (hi - lo < 30) {
    lo = Math.max(0, hi - 30);
    hi = Math.min(100, lo + 30);
  }
  return { lo, hi };
}

/** The overall score month by month, with the tier boundaries behind it. Plain SVG. */
export function ScoreChart({ points }: { points: SeriesPoint[] }) {
  if (points.length === 0) return null;

  const t0 = Date.parse(`${points[0].asOf}T00:00:00Z`);
  const t1 = Date.parse(`${points[points.length - 1].asOf}T00:00:00Z`);
  const span = Math.max(1, t1 - t0);
  const x = (asOf: string) =>
    points.length === 1
      ? (PAD.left + W - PAD.right) / 2
      : PAD.left + ((Date.parse(`${asOf}T00:00:00Z`) - t0) / span) * (W - PAD.left - PAD.right);
  const { lo, hi } = chartRange(points.map((p) => p.overall));
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.asOf)},${y(p.overall)}`).join(" ");
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Overall score over the last twelve months">
      {GUIDES.filter((g) => g >= lo && g <= hi).map((g) => (
        <g key={g}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(g)} y2={y(g)} stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 3" />
          <text x={PAD.left - 6} y={y(g) + 4} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.55}>
            {g}
          </text>
        </g>
      ))}
      {points.length > 1 && <path d={path} fill="none" stroke="#2563eb" strokeWidth={2.5} strokeLinejoin="round" />}
      {points.map((p) => (
        <circle key={p.asOf} cx={x(p.asOf)} cy={y(p.overall)} r={3.5} fill="#2563eb">
          <title>{`${formatDate(p.asOf)}: ${Math.round(p.overall)}${p.tier ? `, tier ${p.tier}` : ""}`}</title>
        </circle>
      ))}
      <text x={Math.min(W - PAD.right, x(last.asOf) + 8)} y={y(last.overall) - 8} textAnchor="end" fontSize={11} fill="currentColor">
        {Math.round(last.overall)}
      </text>
      <text x={PAD.left} y={H - 6} fontSize={11} fill="currentColor" fillOpacity={0.55}>
        {formatDate(points[0].asOf)}
      </text>
      <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.55}>
        {formatDate(last.asOf)}
      </text>
    </svg>
  );
}

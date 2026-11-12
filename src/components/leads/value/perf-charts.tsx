"use client";

import {
  PERFORMANCE_PILLARS,
  PILLAR_COLORS,
  countCeiling,
  daysRange,
  type DaysToPayPoint,
  type PillarPoint,
  type SeatPoint,
  type TicketPoint,
} from "@/lib/customer-value/performance-view";
import { PILLAR_LABELS } from "@/lib/customer-value/summary-view";

/** Small, dependency-free SVG charts for the Performance sub-tab. */

const W = 640;
const H = 180;
const PAD = { left: 38, right: 12, top: 12, bottom: 26 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(ymd: string): string {
  return `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(2, 4)}`;
}

/** Evenly spaced x for the i-th of n months (a single month sits in the middle). */
function xAt(i: number, n: number): number {
  return n === 1 ? (PAD.left + W - PAD.right) / 2 : PAD.left + (i / (n - 1)) * (W - PAD.left - PAD.right);
}

/** Centre of the i-th of n equal bands, so bars sit fully inside the plot area. */
function bandX(i: number, n: number): number {
  return PAD.left + ((i + 0.5) * (W - PAD.left - PAD.right)) / n;
}

function XAxis({ labels, banded = false }: { labels: string[]; banded?: boolean }) {
  const step = Math.max(1, Math.ceil(labels.length / 7));
  const last = labels.length - 1;
  const x = (i: number) => (banded ? bandX(i, labels.length) : xAt(i, labels.length));
  return (
    <>
      {labels.map((m, i) =>
        // Every `step`th label, plus the last, unless it would sit on top of the last.
        (i % step === 0 && last - i >= step) || i === last ? (
          <text
            key={m}
            x={x(i)}
            y={H - 6}
            // The last label hangs off the right edge if centred on its point.
            textAnchor={banded ? "middle" : i === last && labels.length > 1 ? "end" : i === 0 && labels.length > 1 ? "start" : "middle"}
            fontSize={11}
            fill="currentColor"
            fillOpacity={0.55}
          >
            {monthLabel(m)}
          </text>
        ) : null
      )}
    </>
  );
}

function YGrid({ ticks, y, format }: { ticks: number[]; y: (v: number) => number; format?: (v: number) => string }) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 0 ? 0.3 : 0.1} />
          <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.55}>
            {format ? format(t) : t}
          </text>
        </g>
      ))}
    </>
  );
}

/** Segments of consecutive non-null values, so a gap in the data is a gap in the line. */
function segments(values: Array<number | null>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push([i, v]);
  });
  if (cur.length) out.push(cur);
  return out;
}

export function PillarChart({ points }: { points: PillarPoint[] }) {
  const n = points.length;
  const y = (v: number) => PAD.top + (1 - v / 100) * (H - PAD.top - PAD.bottom);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Pillar scores over time">
      <YGrid ticks={[0, 25, 50, 75, 100]} y={y} />
      {PERFORMANCE_PILLARS.map((p) =>
        segments(points.map((pt) => pt[p])).map((seg, k) =>
          seg.length === 1 ? (
            <circle key={`${p}-${k}`} cx={xAt(seg[0][0], n)} cy={y(seg[0][1])} r={3.5} fill={PILLAR_COLORS[p]} />
          ) : (
            <polyline
              key={`${p}-${k}`}
              fill="none"
              stroke={PILLAR_COLORS[p]}
              strokeWidth={2}
              strokeLinejoin="round"
              points={seg.map(([i, v]) => `${xAt(i, n)},${y(v)}`).join(" ")}
            />
          )
        )
      )}
      <XAxis labels={points.map((p) => p.asOf)} />
    </svg>
  );
}

export function PillarLegend() {
  return (
    <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
      {PERFORMANCE_PILLARS.map((p) => (
        <span key={p} className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: PILLAR_COLORS[p] }} />
          {PILLAR_LABELS[p]}
        </span>
      ))}
    </div>
  );
}

export function DaysToPayChart({ points }: { points: DaysToPayPoint[] }) {
  const n = points.length;
  const { lo, hi } = daysRange(points.flatMap((p) => (p.days === null ? [] : [p.days])));
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Average days to pay by month">
      <YGrid ticks={ticks} y={y} />
      {points.map((p, i) =>
        p.days === null ? null : (
          <g key={p.month}>
            <line x1={xAt(i, n)} x2={xAt(i, n)} y1={y(0)} y2={y(p.days)} stroke={p.days <= 0 ? "#059669" : p.days <= 7 ? "#d97706" : "#dc2626"} strokeWidth={2} />
            <circle cx={xAt(i, n)} cy={y(p.days)} r={4.5} fill={p.days <= 0 ? "#059669" : p.days <= 7 ? "#d97706" : "#dc2626"}>
              <title>{`${monthLabel(p.month)}: ${p.days > 0 ? `${p.days.toFixed(1)} days late` : p.days < 0 ? `${Math.abs(p.days).toFixed(1)} days early` : "on the day"} (${p.invoices} invoice${p.invoices === 1 ? "" : "s"})`}</title>
            </circle>
          </g>
        )
      )}
      <XAxis labels={points.map((p) => p.month)} />
    </svg>
  );
}

export function SeatsChart({ points, hasUsage }: { points: SeatPoint[]; hasUsage: boolean }) {
  const n = points.length;
  const ceiling = countCeiling(points.flatMap((p) => [p.paid ?? 0, p.used ?? 0]), 4);
  const y = (v: number) => PAD.top + (1 - v / ceiling) * (H - PAD.top - PAD.bottom);
  const ticks = [0, Math.round(ceiling / 2), ceiling].filter((v, i, a) => a.indexOf(v) === i);
  const line = (values: Array<number | null>, color: string, dash?: string) =>
    segments(values).map((seg, k) =>
      seg.length === 1 ? (
        <circle key={k} cx={xAt(seg[0][0], n)} cy={y(seg[0][1])} r={3.5} fill={color} />
      ) : (
        <polyline key={k} fill="none" stroke={color} strokeWidth={2.2} strokeDasharray={dash} points={seg.map(([i, v]) => `${xAt(i, n)},${y(v)}`).join(" ")} />
      )
    );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Seats paid for and seats used">
      <YGrid ticks={ticks} y={y} />
      {line(points.map((p) => p.paid), "#6b7280", "5 4")}
      {hasUsage && line(points.map((p) => p.used), "#7c3aed")}
      <XAxis labels={points.map((p) => p.month)} />
    </svg>
  );
}

export function TicketsChart({ points }: { points: TicketPoint[] }) {
  const n = points.length;
  const ceiling = countCeiling(points.map((p) => p.tickets), 4);
  const y = (v: number) => PAD.top + (1 - v / ceiling) * (H - PAD.top - PAD.bottom);
  const bw = Math.min(28, ((W - PAD.left - PAD.right) / Math.max(n, 1)) * 0.6);
  const ticks = [0, Math.round(ceiling / 2), ceiling].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Tickets raised by month">
      <YGrid ticks={ticks} y={y} />
      {points.map((p, i) => (
        <g key={p.month}>
          <rect x={bandX(i, n) - bw / 2} y={y(p.tickets)} width={bw} height={Math.max(0, y(0) - y(p.tickets))} rx={2} fill="#d97706">
            <title>{`${monthLabel(p.month)}: ${p.tickets} ticket${p.tickets === 1 ? "" : "s"}, ${p.breached} past target`}</title>
          </rect>
          {p.breached > 0 && <rect x={bandX(i, n) - bw / 2} y={y(p.breached)} width={bw} height={Math.max(0, y(0) - y(p.breached))} rx={2} fill="#b91c1c" />}
        </g>
      ))}
      <XAxis labels={points.map((p) => p.month)} banded />
    </svg>
  );
}

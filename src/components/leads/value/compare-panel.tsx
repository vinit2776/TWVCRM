"use client";

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import {
  COMPARE_MIN_PEERS,
  type CompareResult,
  type HistogramBin,
  type MeasureComparison,
  type Standing,
  type TrendPoint,
} from "@/lib/customer-value/compare-view";

interface CompareData {
  today: string;
  center: { id: string; name: string } | null;
  comparison: CompareResult | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(2, 4)}`;

function format(m: MeasureComparison, v: number | null): string {
  if (v === null) return "—";
  if (m.unit === "₹") return `₹${Math.round(v).toLocaleString("en-IN")}`;
  if (m.unit === "%") return `${Math.round(v)}%`;
  return v.toFixed(Math.abs(v) < 10 ? 1 : 0);
}

const STANDING: Record<Standing, { label: string; className: string }> = {
  better: { label: "Better than most", className: "bg-emerald-100 text-emerald-800" },
  typical: { label: "About typical", className: "bg-slate-100 text-slate-700" },
  worse: { label: "Worse than most", className: "bg-red-100 text-red-800" },
};

function MiniHistogram({ bins }: { bins: HistogramBin[] }) {
  if (bins.length === 0) return null;
  const max = Math.max(...bins.map((b) => b.count), 1);
  return (
    <svg viewBox="0 0 120 28" className="h-7 w-28" role="img" aria-label="How the other customers are spread; the highlighted bar holds this customer">
      {bins.map((b, i) => {
        const w = 120 / bins.length;
        const h = Math.max(b.count > 0 ? 2 : 0, (b.count / max) * 24);
        return <rect key={i} x={i * w + 1} y={26 - h} width={w - 2} height={h} rx={1} fill={b.mine ? "#7c3aed" : "#cbd5e1"} />;
      })}
    </svg>
  );
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  const W = 640, H = 180, L = 38, R = 12, T = 12, B = 26;
  const vals = points.flatMap((p) => [p.mine, p.center].filter((v): v is number => v !== null));
  if (vals.length === 0) return <p className="text-sm text-muted-foreground">No invoices with a due date in the last 12 months.</p>;
  const lo = Math.min(0, Math.floor(Math.min(...vals)));
  const hi = Math.max(1, Math.ceil(Math.max(...vals)));
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = (key: "mine" | "center", color: string, dash?: string) => {
    const segs: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([i, v]);
    });
    if (cur.length) segs.push(cur);
    return segs.map((s, k) => s.length === 1
      ? <circle key={`${key}${k}`} cx={x(s[0][0])} cy={y(s[0][1])} r={3.5} fill={color} />
      : <polyline key={`${key}${k}`} fill="none" stroke={color} strokeWidth={2.2} strokeDasharray={dash} points={s.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")} />);
  };
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Average days to pay by month, this customer against the center">
        {[lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e5e7eb" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="#6b7280">{v}</text>
          </g>
        ))}
        {line("center", "#94a3b8", "5 4")}
        {line("mine", "#7c3aed")}
        {points.map((p, i) => ((i % 2 === 0 && i < points.length - 2) || i === points.length - 1 ? (
          <text key={p.month} x={x(i)} y={H - 6} textAnchor={i === points.length - 1 ? "end" : i === 0 ? "start" : "middle"} fontSize={11} fill="#6b7280">{monthLabel(p.month)}</text>
        ) : null))}
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-violet-600" /> This customer</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-slate-400" /> Center average</span>
      </div>
    </>
  );
}

export function ComparePanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<CompareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/compare`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load the comparison");
      setData((await res.json()) as CompareData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the comparison");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
        <Skeleton className="h-52" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load the comparison"}</p>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const { center, comparison } = data;
  if (!center || !comparison || comparison.measures.every((m) => m.mine === null)) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={Users}
            title="Nothing to compare yet"
            description="This needs a contract at a center and a few months of figures. They are computed each night, or use Recompute above."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Against the rest of {center.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            The last {comparison.windowMonths} months, against {comparison.peerCount} other customer{comparison.peerCount === 1 ? "" : "s"} with at least 3 months of figures.
            {!comparison.judged && ` With fewer than ${COMPARE_MIN_PEERS} others the averages are shown but nobody is judged better or worse.`}
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Measure</th>
                <th className="py-2 pr-3 text-right font-medium">This customer</th>
                <th className="py-2 pr-3 text-right font-medium">Center average</th>
                <th className="py-2 pr-3 text-right font-medium">Difference</th>
                <th className="py-2 pr-3 text-right font-medium">Rank</th>
                <th className="py-2 pr-3 font-medium">Spread</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {comparison.measures.map((m) => (
                <tr key={m.key} className="border-b last:border-0 align-middle">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{m.label}</div>
                    <div className="text-xs text-muted-foreground">{m.unit !== "₹" && m.unit !== "%" ? m.unit : ""}{m.note ? `${m.unit !== "₹" && m.unit !== "%" ? " · " : ""}${m.note}` : ""}</div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">{format(m, m.mine)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{format(m, m.mean)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {m.difference === null ? "—" : `${m.difference > 0 ? "+" : ""}${format(m, m.difference)}`}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{m.rank === null ? "—" : `${m.rank} of ${m.peers + 1}`}</td>
                  <td className="py-2 pr-3"><MiniHistogram bins={m.bins} /></td>
                  <td className="py-2">
                    {m.standing && <Badge variant="secondary" className={`whitespace-nowrap ${STANDING[m.standing].className}`}>{STANDING[m.standing].label}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Rank 1 is the best at the center. A dash means that measure could not be worked out for this customer, for example no door-access data. It is never counted as zero.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Days to pay, against the center</CardTitle>
          <p className="text-xs text-muted-foreground">Average per month for invoices that fell due. Below zero is early.</p>
        </CardHeader>
        <CardContent>
          <TrendChart points={comparison.trend} />
        </CardContent>
      </Card>
    </div>
  );
}

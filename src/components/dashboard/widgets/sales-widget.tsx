"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, cn } from "@/lib/utils";
import {
  SALES_STREAMS,
  SALES_STREAM_COLORS,
  SALES_STREAM_LABELS,
  fyLabel,
  fyStartYearOf,
  type SalesMeasure,
  type SalesStream,
} from "@/lib/sales-widget";

interface Cell {
  invoiced: number;
  collected: number;
  outstanding: number;
  overdue: number;
}
interface MonthRow {
  key: string; // YYYY-MM
  streams: Record<SalesStream, Cell>;
}
interface SalesSummary {
  fy: number;
  today: string;
  months: MonthRow[];
  overdue_buckets: Record<"not_due" | "d_1_30" | "d_31_60" | "d_60_plus" | "no_due_date", number>;
}
interface SalesDocument {
  id: string;
  number: string;
  customer: string;
  streams: SalesStream[];
  invoiced: number;
  collected: number;
  outstanding: number;
  due_date: string | null;
  days_past_due: number | null;
}

const MEASURES: { id: SalesMeasure; label: string }[] = [
  { id: "invoiced", label: "Invoiced" },
  { id: "collected", label: "Collected" },
  { id: "outstanding", label: "Outstanding" },
];
const MEASURE_BLURB: Record<SalesMeasure, string> = {
  invoiced: "Invoiced value (ex-GST) by stream, by billing month",
  collected: "Received against invoices raised in each month (TDS counted as settled)",
  outstanding: "Invoiced minus received, by billing month",
};
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const monthShort = (key: string) => MONTH_SHORT[Number(key.slice(5, 7)) - 1];
const monthLong = (key: string) => `${monthShort(key)} ${key.slice(0, 4)}`;

/** ₹1.2Cr / ₹12.4L / ₹85K — chart axes and KPI tiles need to stay narrow. */
function compactInr(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${Math.round(v)}`;
}

interface SalesWidgetProps {
  locationFilter: string | null;
}

export function SalesWidget({ locationFilter }: SalesWidgetProps) {
  const currentFy = fyStartYearOf(new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10));
  const [fy, setFy] = useState(currentFy);
  const [measure, setMeasure] = useState<SalesMeasure>("invoiced");
  const [hidden, setHidden] = useState<Set<SalesStream>>(new Set());
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [month, setMonth] = useState<string | null>(null);
  const [stream, setStream] = useState<SalesStream | null>(null);
  const [docs, setDocs] = useState<{ rows: SalesDocument[]; total: number } | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);

  const barClicked = useRef(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const qs = new URLSearchParams({ fy: String(fy) });
      if (locationFilter) qs.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/sales?${qs}`);
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(String(res.status));
      setSummary((await res.json()).data);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [fy, locationFilter]);

  useEffect(() => {
    setMonth(null);
    setStream(null);
    loadSummary();
  }, [loadSummary]);

  // Drill-down documents for the selected month / stream / measure. The id guard
  // drops a slow response that was overtaken by a newer click.
  const docsReq = useRef(0);
  useEffect(() => {
    if (!month) { setDocs(null); return; }
    const id = ++docsReq.current;
    setDocsLoading(true);
    const qs = new URLSearchParams({ fy: String(fy), view: "documents", month, measure });
    if (stream) qs.set("stream", stream);
    if (locationFilter) qs.set("location_id", locationFilter);
    fetch(`/api/dashboard/sales?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (id === docsReq.current) setDocs({ rows: j.data.documents, total: j.data.total_count }); })
      .catch(() => { if (id === docsReq.current) setDocs({ rows: [], total: 0 }); })
      .finally(() => { if (id === docsReq.current) setDocsLoading(false); });
  }, [month, stream, measure, fy, locationFilter]);

  const visible = useMemo(() => SALES_STREAMS.filter((s) => !hidden.has(s)), [hidden]);

  const chartData = useMemo(
    () =>
      (summary?.months ?? []).map((m) => {
        const row: Record<string, string | number | null> = { key: m.key, label: monthShort(m.key) };
        for (const s of SALES_STREAMS) row[s] = m.streams[s][measure];
        return row;
      }),
    [summary, measure]
  );

  const totalOf = useCallback(
    (m: MonthRow, which: SalesMeasure = measure) => visible.reduce((a, s) => a + m.streams[s][which], 0),
    [visible, measure]
  );

  const kpis = useMemo(() => {
    if (!summary) return [];
    const sum = (which: SalesMeasure) => summary.months.reduce((a, m) => a + totalOf(m, which), 0);
    const invoiced = sum("invoiced");
    const collected = sum("collected");
    const outstanding = sum("outstanding");
    const overdue = summary.months.reduce((a, m) => a + visible.reduce((x, s) => x + m.streams[s].overdue, 0), 0);
    const streamTotals = visible.map((s) => ({ s, v: summary.months.reduce((a, m) => a + m.streams[s][measure], 0) }));
    const top = streamTotals.sort((a, b) => b.v - a.v)[0];
    if (measure === "outstanding") {
      return [
        { l: "Total outstanding", v: compactInr(outstanding) },
        { l: "% of invoiced", v: invoiced > 0 ? `${((outstanding / invoiced) * 100).toFixed(1)}%` : "—" },
        { l: "Past due date", v: compactInr(overdue), tone: overdue > 0 ? "danger" : undefined },
        { l: "Not yet due", v: compactInr(Math.max(0, outstanding - overdue)) },
        { l: "Biggest gap", v: top && top.v > 0 ? SALES_STREAM_LABELS[top.s] : "—" },
      ];
    }
    if (measure === "collected") {
      return [
        { l: "Collected FY to date", v: compactInr(collected) },
        { l: "Collection rate", v: invoiced > 0 ? `${((collected / invoiced) * 100).toFixed(1)}%` : "—" },
        { l: "Invoiced", v: compactInr(invoiced) },
        { l: "Still to collect", v: compactInr(outstanding) },
        { l: "Largest stream", v: top && top.v > 0 ? SALES_STREAM_LABELS[top.s] : "—" },
      ];
    }
    return [
      { l: "Invoiced FY to date", v: compactInr(invoiced) },
      { l: "Collected", v: compactInr(collected) },
      { l: "Outstanding", v: compactInr(outstanding) },
      { l: "Past due date", v: compactInr(overdue), tone: overdue > 0 ? "danger" : undefined },
      { l: "Largest stream", v: top && top.v > 0 ? SALES_STREAM_LABELS[top.s] : "—" },
    ];
  }, [summary, visible, measure, totalOf]);

  const selectedMonth = summary?.months.find((m) => m.key === month) ?? null;

  function toggleStream(s: SalesStream) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
    if (stream === s) setStream(null);
  }

  if (forbidden) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Sales · {fyLabel(fy)}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">{MEASURE_BLURB[measure]}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Financial year"
              value={fy}
              onChange={(e) => setFy(Number(e.target.value))}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              {[currentFy, currentFy - 1, currentFy - 2].map((y) => (
                <option key={y} value={y}>{fyLabel(y)}</option>
              ))}
            </select>
            <div className="flex overflow-hidden rounded-md border" role="tablist" aria-label="Measure">
              {MEASURES.map((m) => (
                <button
                  key={m.id}
                  role="tab"
                  aria-selected={measure === m.id}
                  onClick={() => setMeasure(m.id)}
                  className={cn(
                    "px-3 py-1.5 text-xs transition-colors",
                    measure === m.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading && !summary ? (
          <div className="flex h-72 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : failed || !summary ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            Couldn&apos;t load sales.
            <button onClick={loadSummary} className="text-xs underline underline-offset-2">Retry</button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              {kpis.map((k) => (
                <div key={k.l} className="rounded-md bg-muted/50 px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">{k.l}</div>
                  <div className={cn("mt-0.5 text-base font-semibold tabular-nums", k.tone === "danger" && "text-red-600")}>{k.v}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {SALES_STREAMS.map((s) => (
                <button
                  key={s}
                  onClick={() => toggleStream(s)}
                  aria-pressed={!hidden.has(s)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-opacity",
                    hidden.has(s) && "opacity-35"
                  )}
                >
                  <span className="h-2 w-2 rounded-sm" style={{ background: SALES_STREAM_COLORS[s] }} />
                  {SALES_STREAM_LABELS[s]}
                </button>
              ))}
            </div>

            <div className={cn("h-72 w-full text-muted-foreground", loading && "opacity-60")}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  onClick={(state) => {
                    // A bar segment fires first and has already chosen month + stream.
                    if (barClicked.current) { barClicked.current = false; return; }
                    // Recharts 3 reports the hovered index as a string ("3"), not a number.
                    const idx = state?.activeTooltipIndex == null ? NaN : Number(state.activeTooltipIndex);
                    const m = Number.isInteger(idx) ? summary.months[idx] : null;
                    if (m && m.key.localeCompare(summary.today.slice(0, 7)) <= 0) { setMonth(m.key); setStream(null); }
                  }}
                >
                  <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "currentColor", fontSize: 12 }} />
                  <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={compactInr} tick={{ fill: "currentColor", fontSize: 11 }} />
                  <Tooltip
                    cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                    formatter={(v, name) => [formatCurrency(Number(v)), SALES_STREAM_LABELS[name as SalesStream] ?? String(name)]}
                    labelFormatter={(_, payload) => {
                      const k = (payload?.[0]?.payload as { key?: string } | undefined)?.key;
                      const m = summary.months.find((x) => x.key === k);
                      return k ? `${monthLong(k)} · total ${formatCurrency(m ? totalOf(m) : 0)}` : "";
                    }}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  {visible.map((s) => (
                    <Bar
                      key={s}
                      dataKey={s}
                      stackId="sales"
                      fill={SALES_STREAM_COLORS[s]}
                      cursor="pointer"
                      onClick={(d: unknown) => {
                        const key = (d as { payload?: { key?: string } })?.payload?.key;
                        if (!key) return;
                        barClicked.current = true;
                        setMonth(key);
                        setStream(s);
                      }}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Click a bar to open that month · click a coloured segment to jump to that stream · click a legend chip to hide a stream.
            </p>

            {selectedMonth && (
              <div className="rounded-lg border p-3">
                <nav className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" aria-label="Drill-down">
                  <button className="text-blue-600 hover:underline" onClick={() => { setMonth(null); setStream(null); }}>{fyLabel(fy)}</button>
                  <span>›</span>
                  {stream ? (
                    <>
                      <button className="text-blue-600 hover:underline" onClick={() => setStream(null)}>{monthLong(selectedMonth.key)}</button>
                      <span>›</span>
                      <b className="font-medium text-foreground">{SALES_STREAM_LABELS[stream]}</b>
                    </>
                  ) : (
                    <b className="font-medium text-foreground">{monthLong(selectedMonth.key)}</b>
                  )}
                </nav>

                <MonthSummary month={selectedMonth} stream={stream} measure={measure} visible={visible} onPickStream={setStream} />

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-1.5 py-1 font-normal">Document</th>
                        <th className="px-1.5 py-1 font-normal">Customer</th>
                        <th className="px-1.5 py-1 font-normal">Stream</th>
                        {measure === "outstanding" ? (
                          <>
                            <th className="px-1.5 py-1 text-right font-normal">Invoiced</th>
                            <th className="px-1.5 py-1 text-right font-normal">Outstanding</th>
                            <th className="px-1.5 py-1 font-normal">Due</th>
                          </>
                        ) : (
                          <th className="px-1.5 py-1 text-right font-normal">{measure === "collected" ? "Collected" : "Invoiced"}</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {docsLoading && !docs ? (
                        <tr><td colSpan={6} className="py-4 text-center text-muted-foreground"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>
                      ) : (docs?.rows ?? []).length === 0 ? (
                        <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">Nothing to show for this selection.</td></tr>
                      ) : (
                        docs!.rows.map((d) => (
                          <tr key={d.id} className="border-b last:border-0 hover:bg-muted/40">
                            <td className="px-1.5 py-1.5 font-mono">
                              <Link href={`/billing?statement=${d.id}`} className="text-blue-600 hover:underline">{d.number}</Link>
                            </td>
                            <td className="px-1.5 py-1.5">{d.customer}</td>
                            <td className="px-1.5 py-1.5">
                              <div className="flex flex-wrap gap-1">
                                {d.streams.map((s) => (
                                  <span key={s} className="rounded-full bg-muted px-2 py-0.5 text-[11px]" style={{ borderLeft: `3px solid ${SALES_STREAM_COLORS[s]}` }}>
                                    {SALES_STREAM_LABELS[s]}
                                  </span>
                                ))}
                              </div>
                            </td>
                            {measure === "outstanding" ? (
                              <>
                                <td className="px-1.5 py-1.5 text-right tabular-nums">{formatCurrency(d.invoiced)}</td>
                                <td className="px-1.5 py-1.5 text-right font-medium tabular-nums">{formatCurrency(d.outstanding)}</td>
                                <td className="px-1.5 py-1.5"><DueBadge days={d.days_past_due} /></td>
                              </>
                            ) : (
                              <td className="px-1.5 py-1.5 text-right tabular-nums">{formatCurrency(measure === "collected" ? d.collected : d.invoiced)}</td>
                            )}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {docs && docs.total > docs.rows.length && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Showing the largest {docs.rows.length} of {docs.total} documents. Amounts are ex-GST.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MonthSummary({
  month,
  stream,
  measure,
  visible,
  onPickStream,
}: {
  month: MonthRow;
  stream: SalesStream | null;
  measure: SalesMeasure;
  visible: SalesStream[];
  onPickStream: (s: SalesStream) => void;
}) {
  const pick = stream ? [stream] : visible;
  const sum = (which: keyof Cell) => pick.reduce((a, s) => a + month.streams[s][which], 0);
  const invoiced = sum("invoiced");
  const collected = sum("collected");
  const outstanding = sum("outstanding");
  const overdue = sum("overdue");
  const headline = measure === "collected" ? collected : measure === "outstanding" ? outstanding : invoiced;
  const pct = invoiced > 0 ? (collected / invoiced) * 100 : 0;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">
          {stream ? `${SALES_STREAM_LABELS[stream]} · ` : ""}{monthLong(month.key)} · {MEASURES.find((m) => m.id === measure)!.label}
        </div>
        <div className="text-lg font-semibold tabular-nums">{formatCurrency(headline)}</div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        Invoiced {compactInr(invoiced)} · Collected {compactInr(collected)} · Outstanding {compactInr(outstanding)}
        {overdue > 0 && <span className="text-red-600"> · {compactInr(overdue)} past due date</span>}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{pct.toFixed(1)}% collected</div>

      {!stream && invoiced > 0 && (
        <>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full">
            {visible.map((s) => {
              const v = month.streams[s][measure];
              return v > 0 ? (
                <button
                  key={s}
                  title={`${SALES_STREAM_LABELS[s]} ${compactInr(v)}`}
                  aria-label={`${SALES_STREAM_LABELS[s]} ${compactInr(v)}`}
                  onClick={() => onPickStream(s)}
                  style={{ width: `${(v / (headline || 1)) * 100}%`, background: SALES_STREAM_COLORS[s] }}
                />
              ) : null;
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {visible.map((s) => {
              const v = month.streams[s][measure];
              return v > 0 ? (
                <button key={s} onClick={() => onPickStream(s)} className="hover:text-foreground">
                  <b className="font-medium text-foreground">{compactInr(v)}</b> {SALES_STREAM_LABELS[s]} ({headline > 0 ? Math.round((v / headline) * 100) : 0}%)
                </button>
              ) : null;
            })}
          </div>
        </>
      )}
    </div>
  );
}

function DueBadge({ days }: { days: number | null }) {
  if (days == null) return <span className="text-muted-foreground">No due date</span>;
  if (days <= 0) {
    return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{days === 0 ? "Due today" : `Due in ${-days} d`}</span>;
  }
  const tone = days > 60 ? "bg-red-50 text-red-700" : days > 30 ? "bg-orange-50 text-orange-700" : "bg-amber-50 text-amber-700";
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px]", tone)}>{days} d overdue</span>;
}

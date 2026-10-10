"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceDot,
} from "recharts";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  buildMonth, compareSameDays, monthLabel, monthStats, projectMonth, shiftMonth, trend,
  type LatestReading, type MidnightReadings, type MonthData,
} from "@/lib/energy-monthly";

const REFRESH_MS = 15 * 60 * 1000; // ledger data lands every 15 min
const TEAL = "#015E65";
const PREV = "#888780";
const YOY = "#BA7517";
const TREND_MONTHS = 13;

type Compare = "prev" | "yoy" | "both";
type View = "cum" | "day";

interface Loaded { today: string; readings: MidnightReadings; latest: LatestReading | null }

const num = (n: number, d = 0) => n.toLocaleString("en-IN", { maximumFractionDigits: d });
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;

export function EnergyMonthlySection({ locationId, deviceId }: { locationId: string; deviceId: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [compare, setCompare] = useState<Compare>("prev");
  const [view, setView] = useState<View>("cum");

  const load = useCallback(async (initial: boolean) => {
    try {
      const res = await fetch(`/api/locations/${locationId}/energy-monthly?device_id=${encodeURIComponent(deviceId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load monthly consumption");
      const d = json.data as { today: string; readings: Record<string, number>; latest: LatestReading | null };
      setData({ today: d.today, readings: new Map(Object.entries(d.readings)), latest: d.latest });
      setError(null);
    } catch (err) {
      // A failed background refresh keeps the last good chart on screen.
      if (initial) setError(err instanceof Error ? err.message : "Failed to load monthly consumption");
    }
  }, [locationId, deviceId]);

  useEffect(() => { load(true); }, [load]);

  const currentMonth = data?.today.slice(0, 7) ?? null;
  const shown = month ?? currentMonth;
  const viewingCurrent = shown != null && shown === currentMonth;
  useEffect(() => {
    if (!viewingCurrent) return;
    const t = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [viewingCurrent, load]);

  const months = useMemo(() => {
    if (!data || !shown) return null;
    const mk = (m: string) => buildMonth(m, data.readings, data.latest, data.today);
    return { cur: mk(shown), prev: mk(shiftMonth(shown, -1)), yoy: mk(shiftMonth(shown, -12)) };
  }, [data, shown]);

  const trendPoints = useMemo(
    () => (data && currentMonth ? trend(currentMonth, TREND_MONTHS, data.readings, data.latest, data.today) : []),
    [data, currentMonth]
  );

  const options = useMemo(
    () => (currentMonth ? Array.from({ length: TREND_MONTHS }, (_, i) => shiftMonth(currentMonth, -i)) : []),
    [currentMonth]
  );

  const chart = useMemo(() => {
    if (!months) return [];
    const pick = (m: MonthData, i: number) => (view === "cum" ? m.cumulative[i] : m.daily[i]);
    return Array.from({ length: 31 }, (_, i) => ({
      day: i + 1,
      cur: i < months.cur.daysInMonth ? pick(months.cur, i) : null,
      prev: i < months.prev.daysInMonth ? pick(months.prev, i) : null,
      yoy: i < months.yoy.daysInMonth ? pick(months.yoy, i) : null,
    }));
  }, [months, view]);

  if (error) {
    return (
      <div className="rounded-lg border p-4">
        <p className="text-sm text-destructive flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {error}</p>
      </div>
    );
  }
  if (!data || !months || !shown) {
    return <div className="rounded-lg border p-4 flex justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }

  const { cur, prev, yoy } = months;
  const hasAnyData = data.readings.size > 0;
  const vsPrev = compareSameDays(cur, prev);
  const vsYoy = compareSameDays(cur, yoy);
  const projected = projectMonth(cur, prev);
  const curStats = monthStats(cur);
  const showPrev = compare === "prev" || compare === "both";
  const showYoy = compare === "yoy" || compare === "both";
  const curLabel = monthLabel(cur.month, true);
  const prevLabel = monthLabel(prev.month, true);
  const yoyLabel = monthLabel(yoy.month, true);
  const unit = view === "cum" ? "kWh" : "kWh / day";
  const maxTrend = Math.max(...trendPoints.map((p) => p.kwh ?? 0), 1);

  const tone = (pct: number) => (pct > 0 ? "text-red-600" : "text-emerald-600");

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">Monthly comparison</h4>
          <p className="text-[11px] text-muted-foreground">Consumption by day of month, from the meter&apos;s running total</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label="Month"
            value={shown}
            onChange={(e) => setMonth(e.target.value)}
            className="h-8 rounded-md border bg-background px-2"
          >
            {options.map((m) => <option key={m} value={m}>{monthLabel(m)}{m === currentMonth ? " (to date)" : ""}</option>)}
          </select>
          <span className="text-muted-foreground">vs</span>
          <div className="flex gap-1.5">
            {([["prev", "Last month"], ["yoy", "Same month last year"], ["both", "Both"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setCompare(k)} className={`rounded-md border px-2.5 py-1 ${compare === k ? "bg-muted font-semibold" : ""}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {!hasAnyData ? (
        <p className="text-sm text-muted-foreground">
          No readings in the local ledger for this meter yet. Use &ldquo;Sync to local ledger&rdquo; below to pull history in.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            <Tile
              label={cur.partial ? `${curLabel} to date (${cur.elapsedDays} d)` : `${monthLabel(cur.month)}`}
              value={cur.totalKwh != null ? `${num(cur.totalKwh)} kWh` : "—"}
              sub={curStats.avgPerDay != null ? `${num(curStats.avgPerDay)} kWh/day` : "no reading at month start"}
            />
            <Tile
              label={vsPrev ? `vs ${cur.partial ? `same ${vsPrev.days} days of ` : ""}${prevLabel}` : `vs ${prevLabel}`}
              value={vsPrev ? signed(vsPrev.pct) : "—"}
              sub={vsPrev ? `${num(vsPrev.otherKwh)} kWh then${!cur.partial && vsPrev.days < prev.daysInMonth ? ` (first ${vsPrev.days} d)` : ""}` : "no comparable figure"}
              toneClass={vsPrev ? tone(vsPrev.pct) : undefined}
            />
            <Tile
              label={vsYoy ? `vs ${cur.partial ? `same ${vsYoy.days} days of ` : ""}${yoyLabel}` : `vs ${yoyLabel}`}
              value={vsYoy ? signed(vsYoy.pct) : "—"}
              sub={vsYoy ? `${num(vsYoy.otherKwh)} kWh then${!cur.partial && vsYoy.days < yoy.daysInMonth ? ` (first ${vsYoy.days} d)` : ""}` : "no history that far back"}
              toneClass={vsYoy ? tone(vsYoy.pct) : undefined}
            />
            {cur.partial ? (
              <Tile label={`Projected ${monthLabel(cur.month, true)}`} value={projected != null ? `${num(projected)} kWh` : "—"} sub={projected != null ? "usual figure for each remaining day" : "too early in the month"} />
            ) : (
              <Tile label={`${prevLabel} full month`} value={prev.totalKwh != null ? `${num(prev.totalKwh)} kWh` : "—"} sub={prev.totalKwh != null ? `${num(prev.totalKwh / prev.daysInMonth)} kWh/day` : "no figure"} />
            )}
            <Tile
              label="Busiest day"
              value={curStats.peakDay ? `${num(curStats.peakDay.kwh)} kWh` : "—"}
              sub={curStats.peakDay ? `${curStats.peakDay.day} ${monthLabel(cur.month, true).split(" ")[0]}` : ""}
            />
          </div>

          {cur.unknownDays > 0 && (
            <p className="text-[11px] text-amber-700">
              {cur.unknownDays} {cur.unknownDays === 1 ? "day" : "days"} of {monthLabel(cur.month)} could not be worked out (a midnight reading is missing) — those show as gaps, not zero.
            </p>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{view === "cum" ? "Cumulative consumption" : "Daily consumption"} by day of month</span>
              <div className="flex gap-1.5 text-xs">
                {([["cum", "Cumulative kWh"], ["day", "Daily kWh"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setView(k)} className={`rounded-md border px-2.5 py-1 ${view === k ? "bg-muted font-semibold" : ""}`}>{l}</button>
                ))}
              </div>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} interval={1} label={{ value: "Day of month", position: "insideBottom", offset: -2, fontSize: 11 }} height={36} />
                  <YAxis tick={{ fontSize: 11 }} width={64} tickFormatter={(v) => num(Number(v))} unit="" />
                  <Tooltip
                    labelFormatter={(d) => `Day ${d}`}
                    formatter={(v, name) => [`${num(Number(v))} ${unit}`, name === "cur" ? monthLabel(cur.month, true) : name === "prev" ? prevLabel : yoyLabel]}
                  />
                  <Legend formatter={(v) => (v === "cur" ? `${monthLabel(cur.month, true)}${cur.partial ? " (to date)" : ""}` : v === "prev" ? prevLabel : yoyLabel)} wrapperStyle={{ fontSize: 11 }} />
                  {showYoy && <Line dataKey="yoy" stroke={YOY} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />}
                  {showPrev && <Line dataKey="prev" stroke={PREV} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />}
                  <Line dataKey="cur" stroke={TEAL} strokeWidth={2.8} dot={false} connectNulls={false} isAnimationActive={false} />
                  {cur.partial && cur.elapsedDays > 0 && (() => {
                    const y = view === "cum" ? cur.cumulative[cur.elapsedDays - 1] : cur.daily[cur.elapsedDays - 1];
                    return y != null ? <ReferenceDot x={cur.elapsedDays} y={y} r={4} fill={TEAL} stroke="white" /> : null;
                  })()}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {view === "cum"
                ? "Where the lines are apart on the same day is how far ahead or behind this month is. Today's figure is partial until the day ends."
                : "Weekday/weekend rhythm shows as dips (Saturdays and Sundays run lower). Gaps are days with a missing reading."}
              {" "}Refreshes every 15 minutes from the local ledger.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <div className="text-sm font-medium">13-month trend <span className="text-[11px] font-normal text-muted-foreground">click a month</span></div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                    // The month in progress is a part-month total; joined to the full months it would read as a
                    // crash, so it is plotted as its own marker (`part`) and kept out of the line (`kwh`).
                    data={trendPoints.map((p) => ({ ...p, label: monthLabel(p.month, true), kwh: p.partial ? null : p.kwh, part: p.partial ? p.kwh : null }))}
                    onClick={(s) => {
                      // Recharts 3 reports the hovered index as a string ("3"), not a number.
                      const i = s?.activeTooltipIndex == null ? NaN : Number(s.activeTooltipIndex);
                      if (Number.isInteger(i) && trendPoints[i]) setMonth(trendPoints[i].month);
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-35} textAnchor="end" height={44} />
                    <YAxis tick={{ fontSize: 11 }} width={52} domain={[0, Math.ceil(maxTrend / 1000) * 1000]} tickFormatter={(v) => `${Number(v) / 1000}k`} />
                    <Tooltip
                      formatter={(v, _n, p) => [`${num(Number(v))} kWh${(p.payload as { partial?: boolean }).partial ? " (to date)" : ""}`, (p.payload as { partial?: boolean }).partial ? "Month to date" : "Total"]}
                    />
                    <Line dataKey="kwh" stroke={TEAL} strokeWidth={2} isAnimationActive={false} connectNulls={false}
                      dot={(p: { cx?: number; cy?: number; value?: number | null; payload?: { month: string }; index?: number }) => {
                        // A series with no figure for this month must draw no marker at all, or it lands at the axis.
                        if (p.value == null) return <g key={p.index} />;
                        const selected = p.payload?.month === shown;
                        return (
                          <circle key={p.index} cx={p.cx} cy={p.cy} r={selected ? 6 : 3.5}
                            fill={selected ? "#E24B4A" : TEAL} stroke={selected ? "#E24B4A" : TEAL} strokeWidth={2} />
                        );
                      }}
                    />
                    <Line dataKey="part" stroke="none" isAnimationActive={false} connectNulls={false}
                      dot={(p: { cx?: number; cy?: number; value?: number | null; payload?: { month: string }; index?: number }) => {
                        // A series with no figure for this month must draw no marker at all, or it lands at the axis.
                        if (p.value == null) return <g key={p.index} />;
                        const selected = p.payload?.month === shown;
                        return (
                          <circle key={p.index} cx={p.cx} cy={p.cy} r={selected ? 6 : 4.5}
                            fill="white" stroke={selected ? "#E24B4A" : TEAL} strokeWidth={2} />
                        );
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[11px] text-muted-foreground">Hollow dot = month in progress (to date, so not joined to the line) · red = the month shown above.</p>
            </div>

            <div>
              <div className="mb-1 text-sm font-medium">Month vs month</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 font-normal">Month</th>
                    <th className="py-1 text-right font-normal">Total</th>
                    <th className="py-1 text-right font-normal">Avg/day</th>
                    <th className="py-1 text-right font-normal">Busiest</th>
                  </tr>
                </thead>
                <tbody>
                  {([[cur, cur.partial ? `${curLabel} (${cur.elapsedDays} d)` : curLabel], [prev, prevLabel], [yoy, yoyLabel]] as [MonthData, string][]).map(([m, label]) => {
                    const s = monthStats(m);
                    return (
                      <tr key={m.month} className="border-b last:border-0">
                        <td className="py-1.5">{label}</td>
                        <td className="py-1.5 text-right tabular-nums">{m.totalKwh != null ? num(m.totalKwh) : "—"}</td>
                        <td className="py-1.5 text-right tabular-nums">{s.avgPerDay != null ? num(s.avgPerDay) : "—"}</td>
                        <td className="py-1.5 text-right tabular-nums">{s.peakDay ? num(s.peakDay.kwh) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-muted-foreground">kWh. A month with a missing reading at its start shows a dash rather than a guess.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, toneClass }: { label: string; value: string; sub?: string; toneClass?: string }) {
  return (
    <div className="rounded-md border bg-muted/40 p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${toneClass ?? ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

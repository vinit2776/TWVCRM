"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, Cell, ReferenceArea, ReferenceLine, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { addDays, istToday } from "@/lib/energy-baseline";
import {
  bandKwh, peakRank, peakVsPrior, slotLabel, summariseDay, topPeakDays,
  type DayCurve, type DayPeak,
} from "@/lib/energy-peak";

const REFRESH_MS = 15 * 60 * 1000; // ledger data lands every 15 min
const TEAL = "#015E65";
const PEAK = "#E24B4A";
const RANGES = [14, 30, 90] as const;
const BAND_COLORS = ["#7F77DD", "#EF9F27", "#D85A30", "#378ADD"];
// Same day-type colours as the daily-usage chart in the baseline section.
const DAY_COLORS = { working: TEAL, sunday: "#BA7517", holiday: "#993556" } as const;
const PARTIAL = "#B4B2A9";

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const fmtShort = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const num = (n: number, d = 1) => n.toLocaleString("en-IN", { maximumFractionDigits: d });

type Unit = "kw" | "kwh";

export function EnergyPeakSection({ locationId, deviceId }: { locationId: string; deviceId: string }) {
  const [today, setToday] = useState(istToday());
  const [date, setDate] = useState(istToday());
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [unit, setUnit] = useState<Unit>("kw");

  const [daily, setDaily] = useState<DayPeak[] | null>(null);
  const [curve, setCurve] = useState<DayCurve | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);

  const base = `/api/locations/${locationId}/energy-peaks?device_id=${encodeURIComponent(deviceId)}`;

  const loadDaily = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setDaily(null);
    try {
      const res = await fetch(`${base}&days=${range}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load daily peaks");
      setDaily(json.data.daily);
      setToday(json.data.today);
      setDailyError(null);
    } catch (err) {
      // A failed background refresh keeps the last good chart on screen.
      if (showSpinner) setDailyError(err instanceof Error ? err.message : "Failed to load daily peaks");
    }
  }, [base, range]);

  // Drop a slow response that a newer day selection has overtaken.
  const dayReq = useRef(0);
  const loadDay = useCallback(async (showSpinner: boolean) => {
    const id = ++dayReq.current;
    if (showSpinner) setCurve(null);
    try {
      const res = await fetch(`${base}&view=day&date=${date}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load this day");
      if (id !== dayReq.current) return;
      setCurve(json.data.kw);
      setDayError(null);
    } catch (err) {
      if (id === dayReq.current && showSpinner) setDayError(err instanceof Error ? err.message : "Failed to load this day");
    }
  }, [base, date]);

  useEffect(() => { loadDaily(true); }, [loadDaily]);
  useEffect(() => { loadDay(true); }, [loadDay]);

  // Only the live day changes; refresh it as new readings land.
  const viewingToday = date === today;
  useEffect(() => {
    if (!viewingToday) return;
    const t = setInterval(() => { loadDaily(false); loadDay(false); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [viewingToday, loadDaily, loadDay]);

  // The API also returns 28 days of lookback for like-for-like comparison; the
  // chart, ranking and top list stay on the range the viewer chose.
  const inRange = useMemo(() => (daily ?? []).filter((d) => d.date >= addDays(today, -(range - 1))), [daily, today, range]);

  const sel = useMemo(() => (curve ? summariseDay(date, curve, today, new Map()) : null), [curve, date, today]);
  const dayInfo = daily?.find((d) => d.date === date) ?? null;
  // Compare/rank against the loaded range, making sure the selected day itself is in it.
  const pool = useMemo(() => {
    if (!daily || !sel) return daily ?? [];
    return [...daily.filter((d) => d.date !== date), { ...sel, dayType: dayInfo?.dayType ?? sel.dayType }];
  }, [daily, sel, date, dayInfo]);
  const vsPrior = useMemo(() => (sel ? peakVsPrior(pool, date) : null), [pool, sel, date]);
  const rank = useMemo(
    () => (sel ? peakRank([...inRange.filter((d) => d.date !== date), ...(sel ? [{ ...sel, dayType: dayInfo?.dayType ?? sel.dayType }] : [])], date) : null),
    [inRange, sel, date, dayInfo]
  );
  const bands = useMemo(() => (curve ? bandKwh(curve) : []), [curve]);
  const bandTotal = bands.reduce((a, b) => a + b.kwh, 0) || 1;
  const top = useMemo(() => topPeakDays(inRange, 5), [inRange]);

  const chart = useMemo(
    () => (curve ?? []).map((v, k) => ({ k, v: v == null ? null : unit === "kw" ? v : Math.round((v / 4) * 100) / 100 })),
    [curve, unit]
  );

  const hasData = sel != null;
  const dayType = dayInfo?.dayType ?? sel?.dayType;
  const dayTag = dayType === "holiday" ? (dayInfo?.holidayName ?? "Holiday") : dayType === "sunday" ? "Sunday" : null;

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">Peak day view</h4>
          <p className="text-[11px] text-muted-foreground">Maximum 15-minute demand, from the local ledger</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))} className="rounded-md border p-1.5 hover:bg-muted">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[10.5rem] text-center text-sm font-medium">
            {viewingToday ? "Today · " : ""}{fmtDay(date)}
          </span>
          <button type="button" aria-label="Next day" disabled={date >= today} onClick={() => setDate(addDays(date, 1))} className="rounded-md border p-1.5 hover:bg-muted disabled:opacity-40">
            <ChevronRight className="h-4 w-4" />
          </button>
          <button type="button" disabled={viewingToday} onClick={() => setDate(today)} className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40">Today</button>
        </div>
      </div>

      {dayTag && <p className="-mt-2 text-[11px] text-amber-700">{dayTag} — usage is normally lower than a working day.</p>}

      {dayError ? (
        <p className="flex items-center gap-2 text-sm text-destructive"><AlertTriangle className="h-4 w-4" /> {dayError}</p>
      ) : curve === null ? (
        <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : !hasData ? (
        <p className="text-sm text-muted-foreground">
          No readings stored for {fmtDay(date)}. {viewingToday
            ? "The ledger fills every hour."
            : "Use “Sync to local ledger” below to pull this date into TWV’s database."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-6">
            <Tile label="Peak demand" value={`${num(sel.peakKw)} kW`} sub={`${slotLabel(sel.peakSlot)}–${slotLabel(sel.peakSlot + 1)}${viewingToday ? " · so far" : ""}`} />
            <Tile
              label={vsPrior?.basis === "off" ? "vs prior Sundays/holidays" : "vs prior 7-day avg peak"}
              value={vsPrior ? `${vsPrior.pct > 0 ? "+" : ""}${vsPrior.pct}%` : "—"}
              sub={vsPrior ? `avg ${vsPrior.avgKw} kW` : "not enough days yet"}
              tone={vsPrior ? (vsPrior.pct > 0 ? "up" : "down") : undefined}
            />
            <Tile label="Day total" value={`${num(sel.kwh, 0)} kWh`} sub={viewingToday ? "so far today" : sel.complete ? "full day" : `${sel.slots}/96 slots`} />
            <Tile label="Average demand" value={`${num(sel.avgKw)} kW`} sub={`load factor ${Math.round(sel.loadFactor * 100)}%`} />
            <Tile label="Base load" value={sel.baseKw != null ? `${num(sel.baseKw)} kW` : "—"} sub="overnight median" />
            <Tile label={`Rank · last ${range} d`} value={rank ? `#${rank.rank}` : "—"} sub={rank ? `of ${rank.of} days by peak` : "needs a full day & history"} />
          </div>

          {!sel.complete && !viewingToday && (
            <p className="text-[11px] text-amber-700">
              Only {sel.slots} of 96 slots have readings, so the real peak could be higher than shown.
            </p>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Demand through the day</span>
              <div className="flex gap-1.5 text-xs">
                {(["kw", "kwh"] as const).map((u) => (
                  <button key={u} type="button" onClick={() => setUnit(u)} className={`rounded-md border px-2.5 py-1 ${unit === u ? "bg-muted font-semibold" : ""}`}>
                    {u === "kw" ? "kW demand" : "kWh per 15 min"}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} barCategoryGap={0}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <ReferenceArea x1={36} x2={75} fill="#888780" fillOpacity={0.08} ifOverflow="visible" />
                  <XAxis dataKey="k" type="number" domain={[-0.5, 95.5]} ticks={[0, 16, 32, 48, 64, 80]} tickFormatter={(k) => slotLabel(Number(k))} tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} unit={unit === "kw" ? " kW" : ""} width={unit === "kw" ? 56 : 40} />
                  <Tooltip
                    labelFormatter={(k) => `${slotLabel(Number(k))}–${slotLabel(Number(k) + 1)} IST`}
                    formatter={(v) => [`${num(Number(v), 2)} ${unit === "kw" ? "kW" : "kWh"}`, unit === "kw" ? "Demand" : "Energy"]}
                  />
                  <ReferenceLine y={unit === "kw" ? sel.avgKw : sel.avgKw / 4} stroke="#888780" strokeDasharray="5 4" />
                  <Bar dataKey="v" isAnimationActive={false}>
                    {chart.map((c) => <Cell key={c.k} fill={c.k === sel.peakSlot ? PEAK : TEAL} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Each bar is one 15-minute reading; demand (kW) = that interval&apos;s energy × 4. Red = the day&apos;s peak · dashed = day average · shaded = 09:00–19:00. Gaps are slots with no reading.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Daily peaks <span className="text-[11px] font-normal text-muted-foreground">click a day to load it</span></span>
                <div className="flex gap-1.5 text-xs">
                  {RANGES.map((r) => (
                    <button key={r} type="button" onClick={() => setRange(r)} className={`rounded-md border px-2.5 py-1 ${range === r ? "bg-muted font-semibold" : ""}`}>{r} d</button>
                  ))}
                </div>
              </div>
              {dailyError ? (
                <p className="flex items-center gap-2 text-sm text-destructive"><AlertTriangle className="h-4 w-4" /> {dailyError}</p>
              ) : daily === null ? (
                <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
              ) : inRange.length === 0 ? (
                <p className="text-sm text-muted-foreground">No synced days in this range.</p>
              ) : (
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={inRange}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={fmtShort} tick={{ fontSize: 10 }} minTickGap={24} />
                      <YAxis tick={{ fontSize: 11 }} unit=" kW" width={56} />
                      <Tooltip
                        labelFormatter={(d) => fmtDay(String(d))}
                        formatter={(v, _n, p) => [`${num(Number(v))} kW at ${slotLabel((p.payload as DayPeak).peakSlot)}${(p.payload as DayPeak).complete ? "" : " (partial day)"}`, "Peak"]}
                      />
                      <Bar
                        dataKey="peakKw"
                        cursor="pointer"
                        isAnimationActive={false}
                        onClick={(d: unknown) => {
                          const picked = (d as { payload?: DayPeak })?.payload?.date;
                          if (picked) setDate(picked);
                        }}
                      >
                        {inRange.map((d) => (
                          <Cell key={d.date} fill={d.date === date ? PEAK : !d.complete ? PARTIAL : DAY_COLORS[d.dayType]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Grey = partial day (peak may be understated) · amber = Sunday · plum = holiday · red = the day shown above.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-sm font-medium">Time-of-day usage <span className="text-[11px] font-normal text-muted-foreground">· {fmtShort(date)}</span></div>
                <div className="space-y-1.5">
                  {bands.map((b, i) => (
                    <div key={b.label} className="flex items-center gap-2 text-[11.5px]">
                      <span className="w-28 shrink-0">{b.label}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full" style={{ width: `${(b.kwh / bandTotal) * 100}%`, background: BAND_COLORS[i] }} />
                      </span>
                      <span className="w-24 text-right tabular-nums">{num(b.kwh, 0)} kWh · {Math.round((b.kwh / bandTotal) * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-sm font-medium">Highest peaks <span className="text-[11px] font-normal text-muted-foreground">· last {range} d, complete days</span></div>
                {top.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No complete days yet.</p>
                ) : (
                  <table className="w-full text-xs">
                    <tbody>
                      {top.map((d) => (
                        <tr key={d.date} onClick={() => setDate(d.date)} className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${d.date === date ? "bg-muted/60" : ""}`}>
                          <td className="py-1.5 pr-2">{fmtDay(d.date)}</td>
                          <td className="py-1.5 text-right tabular-nums">{num(d.peakKw)} kW</td>
                          <td className="py-1.5 pl-2 text-right tabular-nums text-muted-foreground">{slotLabel(d.peakSlot)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-md border bg-muted/40 p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === "up" ? "text-red-600" : tone === "down" ? "text-emerald-600" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

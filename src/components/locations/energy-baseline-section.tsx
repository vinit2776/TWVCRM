"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { AlertTriangle, Loader2, TrendingUp } from "lucide-react";
import { EnergyTodaySection } from "./energy-today-section";
import type {
  Anomaly, BaselineWindow, DailyUsage, DayType, HolidayEntry, WeekdayProfile,
} from "@/lib/energy-baseline";

interface TrendsResponse {
  today: string;
  daily: DailyUsage[];
  baselines: BaselineWindow[];
  weekday_profile: WeekdayProfile[];
  anomalies: Anomaly[];
  holidays: HolidayEntry[];
  holiday_calendar_through: string | null;
}

const DAY_COLORS: Record<DayType, string> = {
  working: "#015E65",
  sunday: "#BA7517",
  holiday: "#993556",
};
const PARTIAL_COLOR = "#B4B2A9";
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmt = (n: number | null, unit = "") => (n == null ? "—" : `${n.toLocaleString("en-IN")}${unit}`);
const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function EnergyBaselineSection({ locationId, deviceId }: { locationId: string; deviceId: string }) {
  const [data, setData] = useState<TrendsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/locations/${locationId}/energy-trends?device_id=${encodeURIComponent(deviceId)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load usage baseline");
        if (!cancelled) setData(json.data);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load usage baseline"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [locationId, deviceId]);

  const chartData = useMemo(
    () => (data?.daily ?? []).map((d) => ({
      ...d,
      label: d.holidayName ? `${d.date} · ${d.holidayName}` : d.date,
      fill: d.complete ? DAY_COLORS[d.dayType] : PARTIAL_COLOR,
    })),
    [data]
  );
  const anomalyDates = useMemo(() => new Set((data?.anomalies ?? []).map((a) => a.date)), [data]);

  if (loading) {
    return <div className="py-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return <p className="text-sm text-destructive flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {error}</p>;
  }
  if (!data) return null;

  const primary = data.baselines[0];
  const hasData = data.daily.some((d) => d.complete);
  const calendarStale = !data.holiday_calendar_through || data.holiday_calendar_through < data.today;
  const weekdayMax = Math.max(1, ...data.weekday_profile.map((w) => w.median ?? 0));

  return (
    <div className="border-t pt-4 space-y-5">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> Usage baseline
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Built from the local ledger. Working day = Monday–Saturday excluding public holidays; non-working = Sundays
          and public holidays. Only complete days count — today and partially-synced days are left out.
        </p>
      </div>

      <EnergyTodaySection locationId={locationId} deviceId={deviceId} />

      {calendarStale && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {data.holiday_calendar_through
            ? `The holiday calendar ends ${fmtDate(data.holiday_calendar_through)} — later holidays will be counted as working days until they're added.`
            : "No holidays on file — every Monday–Saturday is being counted as a working day."}
        </p>
      )}

      {!hasData ? (
        <p className="text-sm text-muted-foreground">
          No complete days in the ledger yet. Use &ldquo;Sync to local ledger&rdquo; above to pull history.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground text-left">
                  <th className="py-1.5 pr-3 font-medium">Baseline window</th>
                  <th className="py-1.5 pr-3 font-medium">
                    <span className="inline-block h-2 w-2 rounded-sm mr-1.5" style={{ background: DAY_COLORS.working }} />
                    Working day
                  </th>
                  <th className="py-1.5 pr-3 font-medium">
                    <span className="inline-block h-2 w-2 rounded-sm mr-1.5" style={{ background: DAY_COLORS.sunday }} />
                    Non-working day
                  </th>
                  <th className="py-1.5 font-medium">Idle load</th>
                </tr>
              </thead>
              <tbody>
                {data.baselines.map((w) => (
                  <tr key={w.key} className="border-t align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{w.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {w.coveredFrom && w.coveredFrom > w.from
                          ? `data since ${fmtDate(w.coveredFrom)}`
                          : `${fmtDate(w.from)} – ${fmtDate(w.to)}`}
                      </div>
                    </td>
                    <td className="py-2 pr-3"><StatsCell stats={w.working} /></td>
                    <td className="py-2 pr-3"><StatsCell stats={w.nonWorking} /></td>
                    <td className="py-2">
                      <div className="font-semibold">{fmt(w.baseLoadKw, " kW")}</div>
                      <div className="text-xs text-muted-foreground">1–5am, non-working</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-1">
              Median kWh per day, with the typical range (25th–75th percentile) beneath. A window with few days is
              thin — treat it as provisional until the ledger has filled in.
            </p>
          </div>

          <div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mb-2">
              <Legend color={DAY_COLORS.working} label="Working day" />
              <Legend color={DAY_COLORS.sunday} label="Sunday" />
              <Legend color={DAY_COLORS.holiday} label="Public holiday" />
              <Legend color={PARTIAL_COLOR} label="Partial / excluded" />
              <span>- - - last-30-day baselines</span>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={fmtDate} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} unit=" kWh" />
                  <Tooltip
                    labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ""}
                    formatter={(v, _n, item) => {
                      const d = item?.payload as DailyUsage | undefined;
                      const note = d && !d.complete ? " (partial)" : anomalyDates.has(d?.date ?? "") ? " (unusual)" : "";
                      return [`${Number(v ?? 0)} kWh${note}`, "Consumption"];
                    }}
                  />
                  {primary.working.median != null && (
                    <ReferenceLine y={primary.working.median} stroke={DAY_COLORS.working} strokeDasharray="5 4" />
                  )}
                  {primary.nonWorking.median != null && (
                    <ReferenceLine y={primary.nonWorking.median} stroke={DAY_COLORS.sunday} strokeDasharray="5 4" />
                  )}
                  <Bar dataKey="kwh" radius={[3, 3, 0, 0]} maxBarSize={28}>
                    {chartData.map((d) => (
                      <Cell
                        key={d.date}
                        fill={d.fill}
                        stroke={anomalyDates.has(d.date) ? "#A32D2D" : undefined}
                        strokeWidth={anomalyDates.has(d.date) ? 2 : 0}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-medium text-muted-foreground mb-2">Weekday profile — median kWh, last 30 days</h4>
            <div className="grid grid-cols-7 gap-2 text-center">
              {data.weekday_profile.map((w) => (
                <div key={w.weekday}>
                  <div className="h-16 flex items-end justify-center">
                    <div
                      className="w-6 rounded-t"
                      style={{
                        height: `${w.median ? Math.max(3, (w.median / weekdayMax) * 100) : 0}%`,
                        background: w.weekday === 0 ? DAY_COLORS.sunday : DAY_COLORS.working,
                      }}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{WEEKDAY_LABELS[w.weekday]}</div>
                  <div className="text-xs font-semibold">{fmt(w.median)}</div>
                  <div className="text-[10px] text-muted-foreground">{w.days}d</div>
                </div>
              ))}
            </div>
          </div>

          {data.anomalies.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Unusual days vs baseline (last 30 days)</h4>
              <ul className="text-sm space-y-1">
                {data.anomalies.map((a) => (
                  <li key={a.date} className="flex gap-3">
                    <span className="w-16 text-muted-foreground">{fmtDate(a.date)}</span>
                    <span className="font-medium">{a.kwh} kWh</span>
                    <span className={a.deviationPct > 0 ? "text-destructive" : "text-amber-700"}>
                      {a.deviationPct > 0 ? "+" : ""}{a.deviationPct}% vs {a.expected} kWh expected
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.holidays.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Holidays in the last 30 days: {data.holidays.map((h) => `${fmtDate(h.date)} ${h.name}`).join(" · ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function StatsCell({ stats }: { stats: BaselineWindow["working"] }) {
  if (stats.median == null) return <span className="text-muted-foreground">No complete days</span>;
  return (
    <>
      <div className="font-semibold">{fmt(stats.median, " kWh")}</div>
      <div className="text-xs text-muted-foreground">
        {fmt(stats.p25)}–{fmt(stats.p75)} · {stats.days} {stats.days === 1 ? "day" : "days"}
      </div>
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center">
      <span className="inline-block h-2 w-2 rounded-sm mr-1.5" style={{ background: color }} />
      {label}
    </span>
  );
}

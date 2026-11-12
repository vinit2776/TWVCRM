"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ComposedChart, Area, Line, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { TodayComparison, TodayStatus } from "@/lib/energy-today";

const REFRESH_MS = 15 * 60 * 1000; // ledger data lands every 15 min
const TEAL = "#015E65";
const BAND = "#9FC9CC";

const STATUS: Record<TodayStatus, { label: string; cls: string }> = {
  on_track: { label: "On track", cls: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  behind: { label: "Behind pace", cls: "bg-amber-50 text-amber-800 border-amber-300" },
  ahead: { label: "Well ahead of pace", cls: "bg-red-50 text-red-800 border-red-300" },
  too_early: { label: "Too early to call", cls: "bg-slate-50 text-slate-700 border-slate-300" },
  insufficient: { label: "Not enough history", cls: "bg-slate-50 text-slate-700 border-slate-300" },
  no_data: { label: "No data yet today", cls: "bg-slate-50 text-slate-700 border-slate-300" },
};

const fmt = (n: number | null | undefined, unit = "") => (n == null ? "—" : `${n.toLocaleString("en-IN")}${unit}`);
const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function EnergyTodaySection({ locationId, deviceId }: { locationId: string; deviceId: string }) {
  const [data, setData] = useState<TodayComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"cumulative" | "power">("cumulative");

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    try {
      const res = await fetch(`/api/locations/${locationId}/energy-today?device_id=${encodeURIComponent(deviceId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load today's comparison");
      setData(json.data);
      setError(null);
    } catch (err) {
      // A failed background refresh keeps the last good chart on screen.
      if (initial) setError(err instanceof Error ? err.message : "Failed to load today's comparison");
    } finally {
      if (initial) setLoading(false);
    }
  }, [locationId, deviceId]);

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const chart = useMemo(() => {
    if (!data) return [];
    return data.slots.map((s) => ({
      k: s.k,
      time: s.time,
      today: mode === "cumulative" ? s.today : s.kw,
      proj: mode === "cumulative" ? s.proj : null,
      band: mode === "cumulative"
        ? (s.p25 != null && s.p75 != null ? [s.p25, s.p75] : null)
        : (s.kwP25 != null && s.kwP75 != null ? [s.kwP25, s.kwP75] : null),
      med: mode === "cumulative" ? s.med : s.kwMed,
    }));
  }, [data, mode]);

  if (loading) {
    return <div className="py-4 flex justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return <p className="text-sm text-destructive flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {error}</p>;
  }
  if (!data) return null;

  const status = STATUS[data.status];
  const hasBaseline = data.typicalEnd != null;
  const ahead = (data.diffKwh ?? 0) >= 0;
  const unit = mode === "cumulative" ? " kWh" : " kW";

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">Today vs baseline</h4>
          <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${status.cls}`}>{status.label}</span>
        </div>
        <div className="flex gap-1.5 text-xs">
          {(["cumulative", "power"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 rounded-md border ${mode === m ? "bg-muted font-semibold" : ""}`}
            >
              {m === "cumulative" ? "Cumulative kWh" : "Power (kW)"}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {fmtDate(data.date)} · compared with {data.peers} complete {data.fallback ? "working days" : data.dayLabel} from the last 30 days
        {data.asOf ? ` · as of ${data.asOf} IST` : ""}
        {data.fallback && " (too few complete Saturdays yet, so all working days are used)"}
      </p>

      {data.status === "no_data" && (
        <p className="text-sm text-muted-foreground">No readings stored yet today. The ledger fills every hour.</p>
      )}
      {data.status === "insufficient" && (
        <p className="text-sm text-muted-foreground">
          Only {data.peers} comparable {data.peers === 1 ? "day" : "days"} so far — at least 3 are needed for a baseline.
        </p>
      )}

      {data.todayKwh != null && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="rounded-md border bg-muted/40 p-2.5">
            <div className="text-[11px] text-muted-foreground">So far today</div>
            <div className="text-lg font-semibold">{fmt(data.todayKwh, " kWh")}</div>
            {data.typicalNow && (
              <div className="text-[11px] text-muted-foreground">
                typical by {data.asOf}: {fmt(data.typicalNow.med)} ({fmt(data.typicalNow.p25)}–{fmt(data.typicalNow.p75)})
              </div>
            )}
          </div>
          <div className="rounded-md border bg-muted/40 p-2.5">
            <div className="text-[11px] text-muted-foreground">Pace vs typical</div>
            <div className="text-lg font-semibold">
              {data.diffKwh != null ? `${ahead ? "+" : "−"}${Math.abs(data.diffKwh).toLocaleString("en-IN")} kWh` : "—"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {data.status === "too_early" ? "morning ramp still under way" : ahead ? "above the typical median" : "below the typical median"}
            </div>
          </div>
          <div className="rounded-md border bg-muted/40 p-2.5">
            <div className="text-[11px] text-muted-foreground">Projected full day</div>
            <div className="text-lg font-semibold">{data.projectedKwh != null ? `≈${Math.round(data.projectedKwh)} kWh` : "—"}</div>
            {data.typicalEnd && (
              <div className="text-[11px] text-muted-foreground">
                typical {Math.round(data.typicalEnd.med ?? 0)} ({Math.round(data.typicalEnd.p25 ?? 0)}–{Math.round(data.typicalEnd.p75 ?? 0)})
              </div>
            )}
          </div>
        </div>
      )}

      {data.status !== "no_data" && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span><span className="inline-block h-2 w-2 rounded-sm mr-1.5" style={{ background: TEAL }} />Today</span>
            {mode === "cumulative" && <span><span className="inline-block h-2 w-2 rounded-sm mr-1.5 opacity-40" style={{ background: TEAL }} />Projected finish</span>}
            {hasBaseline && <span><span className="inline-block h-2 w-2 rounded-sm mr-1.5" style={{ background: BAND }} />Typical range (25th–75th pct)</span>}
            {hasBaseline && <span>- - - Typical (median)</span>}
          </div>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="k" type="number" domain={[0, 95]} ticks={[0, 24, 48, 72, 95]} tickFormatter={(k) => (k === 95 ? "24:00" : `${String(k / 4).padStart(2, "0")}:00`)} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit={unit} width={64} />
                <Tooltip
                  labelFormatter={(k) => `${chart[Number(k)]?.time ?? ""} IST`}
                  formatter={(v, name) => {
                    const label = name === "today" ? "Today" : name === "proj" ? "Projected" : name === "med" ? "Typical" : "Typical range";
                    const text = Array.isArray(v) ? `${v[0]}–${v[1]}${unit}` : `${Number(v)}${unit}`;
                    return [text, label];
                  }}
                />
                {hasBaseline && <Area dataKey="band" stroke="none" fill={BAND} fillOpacity={0.55} isAnimationActive={false} />}
                {hasBaseline && <Line dataKey="med" stroke="#2B7A80" strokeWidth={1.4} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
                {mode === "cumulative" && <Line dataKey="proj" stroke={TEAL} strokeWidth={2} strokeDasharray="2 3" strokeOpacity={0.6} dot={false} isAnimationActive={false} />}
                <Line dataKey="today" stroke={TEAL} strokeWidth={2.6} dot={false} isAnimationActive={false} />
                {data.lastSlot != null && <ReferenceLine x={data.lastSlot} stroke={TEAL} strokeDasharray="3 3" strokeOpacity={0.6} label={{ value: `now ${data.asOf}`, fontSize: 10, fill: TEAL, position: "insideTopRight" }} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {data.status === "too_early"
              ? "Pace is judged once the morning ramp is done (the typical day has used a quarter of its total). Until then the projected finish is the typical rest-of-day added to what's been used."
              : "Behind or ahead means today is more than 10% outside the typical range at this time of day. The projection adds the typical rest-of-day to what's been used so far."}
            {" "}Refreshes every 15 minutes from the local ledger.
          </p>
        </>
      )}
    </div>
  );
}

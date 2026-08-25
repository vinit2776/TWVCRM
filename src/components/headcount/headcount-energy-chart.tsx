"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Zap, AlertTriangle, WifiOff } from "lucide-react";
import {
  ComposedChart, Bar, Scatter, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

interface Props {
  locationId: string;
  mode: "day" | "range";
  /** range mode only — YYYY-MM-DD, defaults to the last 30 days */
  dateFrom?: string;
  dateTo?: string;
}

interface DeviceOption { device_id: string; meter_role: string }

function todayISO() {
  return new Date().toISOString().split("T")[0];
}
function daysAgoISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}
function formatHourTick(ts: number) {
  return new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: true });
}
function formatDayTick(date: string) {
  return new Date(date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
}

const NEARBY_HEADCOUNT_WINDOW_MS = 20 * 60 * 1000; // show a headcount reading if it's within 20 min of the hovered bar

type DayRow = { ts: number; wh: number };
type DayPoint = { ts: number; count: number };

function lookupNearestDay(rows: DayRow[], points: DayPoint[], ts: number) {
  const nearestBar = rows.reduce<{ row: DayRow; dist: number } | null>((best, r) => {
    const dist = Math.abs(r.ts - ts);
    if (dist > NEARBY_HEADCOUNT_WINDOW_MS) return best;
    if (!best || dist < best.dist) return { row: r, dist };
    return best;
  }, null);
  const nearestPoint = points.reduce<{ point: DayPoint; dist: number } | null>((best, p) => {
    const dist = Math.abs(p.ts - ts);
    if (dist > NEARBY_HEADCOUNT_WINDOW_MS) return best;
    if (!best || dist < best.dist) return { point: p, dist };
    return best;
  }, null);
  return { nearestBar, nearestPoint };
}

export function HeadcountEnergyChart({ locationId, mode, dateFrom, dateTo }: Props) {
  const from = mode === "range" ? (dateFrom || daysAgoISO(30)) : todayISO();
  const to = mode === "range" ? (dateTo || todayISO()) : todayISO();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);

  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [dayPoints, setDayPoints] = useState<DayPoint[]>([]);
  const [rangeRows, setRangeRows] = useState<{ date: string; wh: number; peak: number | null }[]>([]);
  const [dayHover, setDayHover] = useState<{ ts: number; x: number; y: number } | null>(null);
  const dayContainerRef = useRef<HTMLDivElement>(null);

  // Resolve whether this location has telemetry, and which device to read
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const cfgRes = await fetch(`/api/locations/${locationId}/electricity-config`);
        const cfgJson = await cfgRes.json();
        const isEnabled = Boolean(cfgJson.data?.onegrid_enabled);
        const savedDefaultDeviceId = cfgJson.data?.onegrid_default_device_id as string | null | undefined;
        if (cancelled) return;
        setEnabled(isEnabled);
        if (!isEnabled) { setLoading(false); return; }

        const devRes = await fetch(`/api/locations/${locationId}/telemetry/devices`);
        const devJson = await devRes.json();
        if (!devRes.ok) throw new Error(devJson.error || "Failed to load meter list");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plants = Object.values(devJson.data?.by_plant ?? {}) as any[];
        const options: DeviceOption[] = plants.flatMap((p) => p.devices);
        // Match the same priority as the location's Electricity tab: saved default first,
        // so the two views never silently disagree about which meter they're reading.
        const saved = savedDefaultDeviceId && options.find((d) => d.device_id === savedDefaultDeviceId);
        const main = options.find((d) => d.meter_role === "main");
        const chosen = saved || main || options[0];
        if (!chosen) { setEnabled(false); setLoading(false); return; }
        if (!cancelled) setDeviceId(chosen.device_id);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [locationId]);

  // Load the chart data once we know the device.
  //
  // The headcount fetch always happens alongside the telemetry fetch (it's
  // needed for the headcount overlay regardless), so on a telemetry failure
  // we already have, for free, a second — sparser — source of energy data:
  // each headcount row's own captured energy_today_wh (from #547's
  // capture-on-save). No extra request, just a different read of data
  // that's already in memory. Promise.allSettled (not .all) so a hard
  // network failure on the OneGrid side doesn't also discard an
  // already-successful headcount fetch.
  useEffect(() => {
    if (!deviceId || enabled !== true) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setUsingFallback(false);
      try {
        if (mode === "day") {
          const [teleResult, hcResult] = await Promise.allSettled([
            fetch(`/api/locations/${locationId}/telemetry/device/${deviceId}?every=15m&derive=delta&fields=Energy_Consumption_Cumulative_Wh`)
              .then(async (r) => ({ ok: r.ok, json: await r.json() })),
            fetch(`/api/headcount?location_id=${locationId}&from=${from}T00:00:00&to=${from}T23:59:59&limit=200`)
              .then(async (r) => ({ ok: r.ok, json: await r.json() })),
          ]);

          if (hcResult.status === "rejected" || !hcResult.value.ok) {
            throw new Error("Failed to load headcount");
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hcRows = (hcResult.value.json.data ?? []) as any[];
          const points = hcRows.map((r) => ({ ts: new Date(r.recorded_at).getTime(), count: r.total_count as number }));

          const teleOk = teleResult.status === "fulfilled" && teleResult.value.ok;
          let rows: { ts: number; wh: number }[];
          if (teleOk) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rows = ((teleResult.value.json.data?.series ?? []) as any[])
              .filter((r) => r.energy_delta_wh != null)
              .map((r) => ({ ts: new Date(r.ts).getTime(), wh: Math.round(r.energy_delta_wh) }));
          } else {
            rows = hcRows
              .filter((r) => r.energy_today_wh != null)
              .map((r) => ({ ts: new Date(r.recorded_at).getTime(), wh: Math.round(r.energy_today_wh) }));
          }
          if (!cancelled) { setDayRows(rows); setDayPoints(points); setUsingFallback(!teleOk); }
        } else {
          const endExclusive = new Date(to);
          endExclusive.setDate(endExclusive.getDate() + 1);
          const [teleResult, hcResult] = await Promise.allSettled([
            fetch(`/api/locations/${locationId}/telemetry/device/${deviceId}?start=${from}&end=${endExclusive.toISOString().split("T")[0]}&every=15m&derive=delta&fields=Energy_Consumption_Cumulative_Wh`)
              .then(async (r) => ({ ok: r.ok, json: await r.json() })),
            fetch(`/api/headcount?location_id=${locationId}&from=${from}T00:00:00&to=${to}T23:59:59&limit=1000`)
              .then(async (r) => ({ ok: r.ok, json: await r.json() })),
          ]);

          if (hcResult.status === "rejected" || !hcResult.value.ok) {
            throw new Error("Failed to load headcount");
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hcRows = (hcResult.value.json.data ?? []) as any[];

          const peakByDay = new Map<string, number>();
          for (const r of hcRows) {
            const day = String(r.recorded_at).slice(0, 10);
            peakByDay.set(day, Math.max(peakByDay.get(day) ?? 0, r.total_count ?? 0));
          }

          const teleOk = teleResult.status === "fulfilled" && teleResult.value.ok;
          const whByDay = new Map<string, number>();
          if (teleOk) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const r of (teleResult.value.json.data?.series ?? []) as any[]) {
              if (r.energy_delta_wh == null) continue;
              const day = String(r.ts).slice(0, 10);
              whByDay.set(day, (whByDay.get(day) ?? 0) + r.energy_delta_wh);
            }
          } else {
            // Fallback: best available approximation is the highest
            // "today so far" reading captured that day — a floor on that
            // day's total, not the true full-day sum.
            for (const r of hcRows) {
              if (r.energy_today_wh == null) continue;
              const day = String(r.recorded_at).slice(0, 10);
              whByDay.set(day, Math.max(whByDay.get(day) ?? 0, r.energy_today_wh));
            }
          }

          const days = [...new Set([...whByDay.keys(), ...peakByDay.keys()])].sort();
          const merged = days.map((date) => ({
            date,
            wh: Math.round(whByDay.get(date) ?? 0),
            peak: peakByDay.has(date) ? (peakByDay.get(date) as number) : null,
          }));
          if (!cancelled) { setRangeRows(merged); setUsingFallback(!teleOk); }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, enabled, mode, locationId, from, to]);

  if (enabled === false) return null;

  // Recharts' "dataMin"/"dataMax" domain keywords don't reliably compute a
  // numeric domain once a <Bar> is mixed with a type="number" axis — every
  // bar and axis tick collapses onto a single x position once there are
  // more than a couple of points (only ever showed up once a meter reported
  // densely enough in one day to expose it). Computing the domain ourselves
  // sidesteps whatever's broken in that path.
  const dayAllTs = [...dayRows.map((r) => r.ts), ...dayPoints.map((p) => p.ts)];
  const dayXDomain: [number, number] = dayAllTs.length
    ? [Math.min(...dayAllTs), Math.max(...dayAllTs)]
    : [0, 1];

  // A day at 15-min resolution can have up to 96 bars. A fixed max width
  // (14px) that made sense for a handful of points overlaps into a solid
  // block once there are dozens — scale it down as point count grows so
  // bars stay visually distinct instead of mashing together.
  const dayBarSize = Math.max(2, Math.min(14, Math.floor(480 / Math.max(dayRows.length, 1))));

  const { nearestBar: dayNearestBar, nearestPoint: dayNearestPoint } = dayHover
    ? lookupNearestDay(dayRows, dayPoints, dayHover.ts)
    : { nearestBar: null, nearestPoint: null };
  const dayContainerWidth = dayContainerRef.current?.clientWidth ?? 0;
  const dayFlipLeft = dayHover != null && dayContainerWidth > 0 && dayHover.x > dayContainerWidth * 0.6;

  // Recharts v3's own activeIndex/activeLabel tracking (both the default
  // <Tooltip> and the chart-level onMouseMove callback) freezes at the first
  // resolved index for the rest of a hover session on this Bar+Scatter combo
  // — confirmed by dispatching mousemove at many different positions and
  // watching activeCoordinate.x update on every call while activeIndex never
  // changed. activeCoordinate.x does track the real cursor position
  // correctly, so instead of trusting Recharts' snapped label, two rendered
  // bars' real screen positions are measured once per hover and the
  // cursor's own clientX is linearly inverted against them.
  function handleDayMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const container = dayContainerRef.current;
    if (!container || dayRows.length === 0) return;
    const bars = container.querySelectorAll(".recharts-bar-rectangle path");
    if (bars.length < 2) return;
    const firstRect = bars[0].getBoundingClientRect();
    const lastRect = bars[bars.length - 1].getBoundingClientRect();
    const x0 = firstRect.left + firstRect.width / 2;
    const x1 = lastRect.left + lastRect.width / 2;
    const ts0 = dayRows[0].ts;
    const ts1 = dayRows[dayRows.length - 1].ts;
    if (x1 === x0) return;
    const clampedX = Math.min(Math.max(e.clientX, Math.min(x0, x1)), Math.max(x0, x1));
    const frac = (clampedX - x0) / (x1 - x0);
    const ts = ts0 + frac * (ts1 - ts0);
    const containerRect = container.getBoundingClientRect();
    setDayHover({ ts, x: e.clientX - containerRect.left, y: e.clientY - containerRect.top });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Headcount vs energy{mode === "day" ? " — today" : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="py-10 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && error && (
          <p className="text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {error}
          </p>
        )}
        {!loading && !error && usingFallback && (
          <p className="text-xs text-amber-600 flex items-center gap-1.5 mb-3">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            Live meter unreachable — showing readings captured with headcount logs instead
          </p>
        )}
        {!loading && !error && mode === "day" && dayRows.length === 0 && dayPoints.length === 0 && (
          <p className="text-sm text-muted-foreground">No energy or headcount data for today yet.</p>
        )}
        {!loading && !error && mode === "day" && (dayRows.length > 0 || dayPoints.length > 0) && (
          <div
            ref={dayContainerRef}
            className="relative h-64"
            onMouseMove={handleDayMouseMove}
            onMouseLeave={() => setDayHover(null)}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dayRows} margin={{ left: 4, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="ts" type="number" domain={dayXDomain} allowDuplicatedCategory={false}
                  tickFormatter={formatHourTick} tick={{ fontSize: 11 }}
                />
                <YAxis yAxisId="wh" tick={{ fontSize: 11 }} width={50} label={{ value: "Wh", angle: -90, position: "insideLeft", fontSize: 11 }} />
                <YAxis yAxisId="hc" orientation="right" tick={{ fontSize: 11 }} width={36} allowDecimals={false} label={{ value: "people", angle: 90, position: "insideRight", fontSize: 11 }} />
                <Bar yAxisId="wh" dataKey="wh" fill={usingFallback ? "#FAC775" : "#5DCAA5"} barSize={dayBarSize} name={usingFallback ? "Captured reading (Wh)" : "Consumption (Wh)"} background={{ fill: "transparent" }} />
                <Scatter yAxisId="hc" data={dayPoints} dataKey="count" fill="#D85A30" name="Headcount" />
              </ComposedChart>
            </ResponsiveContainer>
            {dayHover && (dayNearestBar || dayNearestPoint) && (
              <div
                className="pointer-events-none absolute z-10 bg-background border rounded-md shadow-sm px-3 py-2 text-xs space-y-1 whitespace-nowrap"
                style={{
                  left: dayHover.x,
                  top: dayHover.y,
                  transform: `translate(${dayFlipLeft ? "-100%" : "0%"}, -110%)`,
                }}
              >
                <p className="font-medium">{formatHourTick(dayHover.ts)}</p>
                {dayNearestBar && (
                  <p>
                    {usingFallback ? "Captured reading" : "Consumption"}: {dayNearestBar.row.wh} Wh ({formatHourTick(dayNearestBar.row.ts)})
                  </p>
                )}
                {dayNearestPoint && <p>Headcount: {dayNearestPoint.point.count} (logged {formatHourTick(dayNearestPoint.point.ts)})</p>}
              </div>
            )}
          </div>
        )}
        {!loading && !error && mode === "range" && rangeRows.length === 0 && (
          <p className="text-sm text-muted-foreground">No energy or headcount data in this range.</p>
        )}
        {!loading && !error && mode === "range" && rangeRows.length > 0 && (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rangeRows} margin={{ left: 4, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayTick} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="wh" tick={{ fontSize: 11 }} width={50} label={{ value: "Wh", angle: -90, position: "insideLeft", fontSize: 11 }} />
                <YAxis yAxisId="hc" orientation="right" tick={{ fontSize: 11 }} width={36} allowDecimals={false} label={{ value: "peak", angle: 90, position: "insideRight", fontSize: 11 }} />
                <Tooltip labelFormatter={(v) => formatDayTick(String(v))} />
                <Bar yAxisId="wh" dataKey="wh" fill={usingFallback ? "#FAC775" : "#5DCAA5"} maxBarSize={40} name={usingFallback ? "Best captured reading that day (Wh)" : "Daily consumption (Wh)"} />
                <Line yAxisId="hc" dataKey="peak" stroke="#D85A30" strokeWidth={2} dot={{ r: 3 }} connectNulls name="Peak headcount" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Zap, AlertTriangle } from "lucide-react";
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

export function HeadcountEnergyChart({ locationId, mode, dateFrom, dateTo }: Props) {
  const from = mode === "range" ? (dateFrom || daysAgoISO(30)) : todayISO();
  const to = mode === "range" ? (dateTo || todayISO()) : todayISO();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dayRows, setDayRows] = useState<{ ts: number; wh: number }[]>([]);
  const [dayPoints, setDayPoints] = useState<{ ts: number; count: number }[]>([]);
  const [rangeRows, setRangeRows] = useState<{ date: string; wh: number; peak: number | null }[]>([]);

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

  // Load the chart data once we know the device
  useEffect(() => {
    if (!deviceId || enabled !== true) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (mode === "day") {
          const [teleRes, hcRes] = await Promise.all([
            fetch(`/api/locations/${locationId}/telemetry/device/${deviceId}?every=15m&derive=delta&fields=Energy_Consumption_Cumulative_Wh`),
            fetch(`/api/headcount?location_id=${locationId}&from=${from}T00:00:00&to=${from}T23:59:59&limit=200`),
          ]);
          const teleJson = await teleRes.json();
          const hcJson = await hcRes.json();
          if (!teleRes.ok) throw new Error(teleJson.error || "Failed to load telemetry");
          if (!hcRes.ok) throw new Error(hcJson.error || "Failed to load headcount");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = ((teleJson.data?.series ?? []) as any[])
            .filter((r) => r.energy_delta_wh != null)
            .map((r) => ({ ts: new Date(r.ts).getTime(), wh: Math.round(r.energy_delta_wh) }));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const points = ((hcJson.data ?? []) as any[])
            .map((r) => ({ ts: new Date(r.recorded_at).getTime(), count: r.total_count as number }));
          if (!cancelled) { setDayRows(rows); setDayPoints(points); }
        } else {
          const endExclusive = new Date(to);
          endExclusive.setDate(endExclusive.getDate() + 1);
          const [teleRes, hcRes] = await Promise.all([
            fetch(`/api/locations/${locationId}/telemetry/device/${deviceId}?start=${from}&end=${endExclusive.toISOString().split("T")[0]}&every=15m&derive=delta&fields=Energy_Consumption_Cumulative_Wh`),
            fetch(`/api/headcount?location_id=${locationId}&from=${from}T00:00:00&to=${to}T23:59:59&limit=1000`),
          ]);
          const teleJson = await teleRes.json();
          const hcJson = await hcRes.json();
          if (!teleRes.ok) throw new Error(teleJson.error || "Failed to load telemetry");
          if (!hcRes.ok) throw new Error(hcJson.error || "Failed to load headcount");

          const whByDay = new Map<string, number>();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const r of (teleJson.data?.series ?? []) as any[]) {
            if (r.energy_delta_wh == null) continue;
            const day = String(r.ts).slice(0, 10);
            whByDay.set(day, (whByDay.get(day) ?? 0) + r.energy_delta_wh);
          }
          const peakByDay = new Map<string, number>();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const r of (hcJson.data ?? []) as any[]) {
            const day = String(r.recorded_at).slice(0, 10);
            peakByDay.set(day, Math.max(peakByDay.get(day) ?? 0, r.total_count ?? 0));
          }
          const days = [...new Set([...whByDay.keys(), ...peakByDay.keys()])].sort();
          const merged = days.map((date) => ({
            date,
            wh: Math.round(whByDay.get(date) ?? 0),
            peak: peakByDay.has(date) ? (peakByDay.get(date) as number) : null,
          }));
          if (!cancelled) setRangeRows(merged);
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
        {!loading && !error && mode === "day" && dayRows.length === 0 && dayPoints.length === 0 && (
          <p className="text-sm text-muted-foreground">No energy or headcount data for today yet.</p>
        )}
        {!loading && !error && mode === "day" && (dayRows.length > 0 || dayPoints.length > 0) && (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dayRows} margin={{ left: 4, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="ts" type="number" domain={["dataMin", "dataMax"]}
                  tickFormatter={formatHourTick} tick={{ fontSize: 11 }}
                />
                <YAxis yAxisId="wh" tick={{ fontSize: 11 }} width={50} label={{ value: "Wh", angle: -90, position: "insideLeft", fontSize: 11 }} />
                <YAxis yAxisId="hc" orientation="right" tick={{ fontSize: 11 }} width={36} allowDecimals={false} label={{ value: "people", angle: 90, position: "insideRight", fontSize: 11 }} />
                <Tooltip labelFormatter={(v) => formatHourTick(Number(v))} />
                <Bar yAxisId="wh" dataKey="wh" fill="#5DCAA5" maxBarSize={14} name="Consumption (Wh)" />
                <Scatter yAxisId="hc" data={dayPoints} dataKey="count" fill="#D85A30" name="Headcount" />
              </ComposedChart>
            </ResponsiveContainer>
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
                <Bar yAxisId="wh" dataKey="wh" fill="#5DCAA5" maxBarSize={40} name="Daily consumption (Wh)" />
                <Line yAxisId="hc" dataKey="peak" stroke="#D85A30" strokeWidth={2} dot={{ r: 3 }} connectNulls name="Peak headcount" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

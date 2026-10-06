"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  BarChart, Bar, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import {
  Loader2, RefreshCw, Zap, Gauge, Activity, AlertTriangle, PlugZap, DatabaseZap,
} from "lucide-react";
import { toast } from "sonner";
import { EnergyBaselineSection } from "./energy-baseline-section";

interface DeviceOption {
  device_id: string;
  device_label: string;
  meter_role: string;
  plant_name: string;
}

interface DevicesResponse {
  devices: string[];
  no_telemetry_yet: string[];
  by_plant: Record<string, { plant_name: string; devices: { device_id: string; device_label: string; meter_role: string }[] }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface TelemetryResponse { series: Record<string, any>[] }

const LIVE_REFRESH_MS = 15 * 60 * 1000; // OneGrid data lands every 15 min — polling faster buys nothing

function todayISO() {
  return new Date().toISOString().split("T")[0];
}
function daysAgoISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

interface Props {
  locationId: string;
  defaultDeviceId?: string | null;
}

export function ElectricityTelemetryPanel({ locationId, defaultDeviceId }: Props) {
  const [deviceOptions, setDeviceOptions] = useState<DeviceOption[]>([]);
  const [noTelemetryYet, setNoTelemetryYet] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [savedDefaultDevice, setSavedDefaultDevice] = useState<string | null>(defaultDeviceId ?? null);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const [live, setLive] = useState<TelemetryResponse | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const [dateFrom, setDateFrom] = useState(daysAgoISO(7));
  const [dateTo, setDateTo] = useState(todayISO());
  const [history, setHistory] = useState<{ date: string; kwh: number }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const res = await fetch(`/api/locations/${locationId}/telemetry/devices`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load devices");
      const data = json.data as DevicesResponse;
      const options: DeviceOption[] = Object.values(data.by_plant).flatMap((plant) =>
        plant.devices.map((d) => ({ ...d, plant_name: plant.plant_name }))
      );
      setDeviceOptions(options);
      setNoTelemetryYet(data.no_telemetry_yet ?? []);
      if (options.length > 0) {
        const saved = savedDefaultDevice && options.find((d) => d.device_id === savedDefaultDevice);
        const main = options.find((d) => d.meter_role === "main");
        setSelectedDevice((saved || main)?.device_id ?? options[0].device_id);
      }
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      setDevicesLoading(false);
    }
  }, [locationId, savedDefaultDevice]);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  const fetchLive = useCallback(async () => {
    if (!selectedDevice) return;
    setLiveLoading(true);
    setLiveError(null);
    try {
      const params = new URLSearchParams({ every: "15m", derive: "delta" });
      const res = await fetch(`/api/locations/${locationId}/telemetry/device/${selectedDevice}?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load live telemetry");
      setLive(json.data);
      setLastRefreshed(new Date());
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : "Failed to load live telemetry");
    } finally {
      setLiveLoading(false);
    }
  }, [locationId, selectedDevice]);

  useEffect(() => {
    fetchLive();
    const interval = setInterval(fetchLive, LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchLive]);

  const fetchHistory = useCallback(async () => {
    if (!selectedDevice) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const endExclusive = new Date(dateTo);
      endExclusive.setDate(endExclusive.getDate() + 1);
      const params = new URLSearchParams({
        start: dateFrom,
        end: endExclusive.toISOString().split("T")[0],
        every: "15m",
        derive: "delta",
        fields: "Energy_Consumption_Cumulative_Wh",
      });
      const res = await fetch(`/api/locations/${locationId}/telemetry/device/${selectedDevice}?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load history");
      const data = json.data as TelemetryResponse;
      const byDay = new Map<string, number>();
      for (const row of data.series) {
        if (row.energy_delta_wh == null) continue;
        const day = String(row.ts).slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + row.energy_delta_wh);
      }
      const days = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, wh]) => ({ date, kwh: Math.round((wh / 1000) * 100) / 100 }));
      setHistory(days);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setHistoryLoading(false);
    }
  }, [locationId, selectedDevice, dateFrom, dateTo]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const handleSelectDevice = useCallback(async (deviceId: string) => {
    setSelectedDevice(deviceId);
    if (deviceId === savedDefaultDevice) return;
    try {
      const res = await fetch(`/api/locations/${locationId}/telemetry/default-device`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId }),
      });
      if (!res.ok) throw new Error();
      setSavedDefaultDevice(deviceId);
      toast.success("Default meter updated for this location");
    } catch {
      toast.error("Couldn't save this as the default meter");
    }
  }, [locationId, savedDefaultDevice]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/locations/${locationId}/telemetry/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: dateFrom, end: dateTo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Sync failed");
      const { rows_upserted, complete, synced_through, chunks_processed, chunks_total } = json.data;
      if (complete) {
        toast.success(`Synced ${rows_upserted.toLocaleString("en-IN")} readings (${dateFrom} to ${dateTo}) to the local ledger`);
      } else {
        toast.warning(
          `Synced ${rows_upserted.toLocaleString("en-IN")} readings through ${synced_through} (${chunks_processed}/${chunks_total} chunks) — click Sync again to continue from there`
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [locationId, dateFrom, dateTo]);

  const latest = useMemo(() => (live?.series.length ? live.series[live.series.length - 1] : null), [live]);
  const todayWh = useMemo(
    () => (live?.series ?? []).reduce((sum, r) => sum + (r.energy_delta_wh ?? 0), 0),
    [live]
  );
  const totalRangeKwh = useMemo(() => history.reduce((s, d) => s + d.kwh, 0), [history]);

  if (devicesLoading) {
    return (
      <Card>
        <CardContent className="py-8 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (devicesError) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {devicesError}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (deviceOptions.length === 0) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">
            No meters registered to this location&apos;s OneGrid org yet — contact OneGrid ops.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Live Meter Telemetry
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-3">
          <Select value={selectedDevice} onValueChange={handleSelectDevice}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Select meter…" />
            </SelectTrigger>
            <SelectContent>
              {deviceOptions.map((d) => (
                <SelectItem key={d.device_id} value={d.device_id}>
                  {d.device_label} ({d.meter_role}) — {d.plant_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedDevice === savedDefaultDevice && (
            <Badge variant="secondary">Default for this location</Badge>
          )}
          {noTelemetryYet.includes(selectedDevice) && (
            <Badge variant="outline" className="text-amber-600 border-amber-300">
              Registered, not reporting yet
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={fetchLive} disabled={liveLoading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${liveLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {lastRefreshed && (
            <span className="text-xs text-muted-foreground">
              Updated {lastRefreshed.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>

        {liveError && (
          <p className="text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {liveError}
          </p>
        )}

        {!liveError && !latest && !liveLoading && (
          <p className="text-sm text-muted-foreground">No data yet for today.</p>
        )}

        {latest && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatTile icon={<Zap className="h-3.5 w-3.5" />} label="Today" value={`${todayWh.toFixed(0)} Wh`} />
            <StatTile icon={<Gauge className="h-3.5 w-3.5" />} label="Voltage" value={latest.Vll_Avg != null ? `${latest.Vll_Avg.toFixed(1)} V` : "—"} />
            <StatTile icon={<Activity className="h-3.5 w-3.5" />} label="Power Factor" value={latest.PF_Avg != null ? latest.PF_Avg.toFixed(2) : "—"} />
            <StatTile icon={<Activity className="h-3.5 w-3.5" />} label="Frequency" value={latest.Freq != null ? `${latest.Freq.toFixed(2)} Hz` : "—"} />
            <StatTile
              icon={<PlugZap className="h-3.5 w-3.5" />}
              label="Grid"
              value={latest.PowerGrid_Shutdown ? "Outage" : "Online"}
              alert={Boolean(latest.PowerGrid_Shutdown)}
            />
          </div>
        )}

        <div className="border-t pt-4 space-y-3">
          <div className="flex items-end gap-4">
            <div>
              <Label className="text-xs">From</Label>
              <Input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input type="date" value={dateTo} max={todayISO()} onChange={(e) => setDateTo(e.target.value)} className="w-40" />
            </div>
            {!historyLoading && (
              <span className="text-xs text-muted-foreground mb-2">{totalRangeKwh.toFixed(1)} kWh total</span>
            )}
            <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing} className="mb-0">
              {syncing
                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                : <DatabaseZap className="h-3.5 w-3.5 mr-1.5" />}
              {syncing ? "Syncing…" : "Sync to local ledger"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pulls this date range into TWV&apos;s own database, independent of OneGrid&apos;s retention — for older
            periods than headcount logging alone would reach. Large ranges may need a few clicks to finish.
          </p>

          {historyLoading && (
            <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          )}
          {historyError && (
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> {historyError}
            </p>
          )}
          {!historyLoading && !historyError && history.length === 0 && (
            <p className="text-sm text-muted-foreground">No consumption data in this range.</p>
          )}
          {!historyLoading && !historyError && history.length > 0 && (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} unit=" kWh" />
                  <Tooltip formatter={(v: number | undefined) => [`${v ?? 0} kWh`, "Consumption"]} />
                  <Bar dataKey="kwh" fill="#015E65" radius={[4, 4, 0, 0]} maxBarSize={60} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {selectedDevice && <EnergyBaselineSection locationId={locationId} deviceId={selectedDevice} />}
      </CardContent>
    </Card>
  );
}

function StatTile({ icon, label, value, alert }: { icon: ReactNode; label: string; value: string; alert?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${alert ? "border-destructive bg-destructive/5" : ""}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <p className={`text-lg font-semibold mt-1 ${alert ? "text-destructive" : ""}`}>{value}</p>
    </div>
  );
}

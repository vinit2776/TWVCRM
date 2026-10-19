"use client";

import { useCallback, useEffect, useState } from "react";
import { Wifi } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import type { DeviceHow } from "@/lib/customer-value/wifi-devices";
import type { DaySeriesPoint, Heatmap, ProfileTag } from "@/lib/customer-value/wifi-usage";

interface WifiDeviceRow {
  mac: string;
  name: string;
  label: string | null;
  memberName: string | null;
  hostname: string | null;
  how: DeviceHow[];
  seat: number | null;
  contractId: string;
  contractNumber: string;
  lastSeen: string | null;
  usage: { bytes: number; download: number; upload: number; activeDays: number } | null;
}

interface WifiData {
  status: "ok" | "no_center" | "no_wifi" | "no_devices";
  center: { id: string; name: string } | null;
  consoleReachable?: boolean;
  seats?: number;
  capacity?: number | null;
  windowDays?: number;
  devices?: WifiDeviceRow[];
  summary?: { knownDays: number; bytes: number; download: number; upload: number; activeDays: number; activeDevices: number; centerShare: number | null };
  series?: DaySeriesPoint[];
  heatmap?: Heatmap;
  tags?: ProfileTag[];
}

const NOT_AVAILABLE: Record<"no_center" | "no_wifi" | "no_devices", { title: string; description: string }> = {
  no_center: { title: "No center yet", description: "This customer has no contract at a center, so there is no Wi-Fi to show." },
  no_wifi: { title: "No UniFi Wi-Fi at this center", description: "This center is not set up with UniFi, so Wi-Fi usage is not recorded." },
  no_devices: { title: "No devices linked to this customer", description: "Usage only counts devices that were deliberately linked: a contract seat voucher, an ad-hoc voucher linked to a contract, or a device named here. None are linked yet." },
};

const gb = (b: number) => (b >= 1e11 ? `${Math.round(b / 1e9)} GB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const HOW_LABEL: Record<DeviceHow, string> = { seat: "Seat voucher", adhoc: "Ad-hoc voucher", label: "Named by staff" };

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function DailyChart({ points }: { points: DaySeriesPoint[] }) {
  const W = 640, H = 170, L = 58, R = 8, T = 10, B = 24;
  const max = Math.max(...points.map((p) => p.bytes), 1);
  const band = (W - L - R) / points.length;
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Wi-Fi data used per day by this customer's devices">
      {[0, max / 2, max].map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#e5e7eb" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#6b7280">{gb(t)}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const x = L + i * band;
        return p.known ? (
          <rect key={p.day} x={x + 0.5} y={y(p.bytes)} width={Math.max(1, band - 1)} height={Math.max(0, y(0) - y(p.bytes))} fill="#7c3aed">
            <title>{`${dayLabel(p.day)}: ${gb(p.bytes)}`}</title>
          </rect>
        ) : (
          <rect key={p.day} x={x + 0.5} y={T} width={Math.max(1, band - 1)} height={H - T - B} fill="#f1f5f9">
            <title>{`${dayLabel(p.day)}: no data recorded`}</title>
          </rect>
        );
      })}
      {[0, Math.floor(points.length / 2), points.length - 1].map((i) => (
        <text key={i} x={L + i * band} y={H - 6} textAnchor={i === points.length - 1 ? "end" : i === 0 ? "start" : "middle"} fontSize={11} fill="#6b7280">{dayLabel(points[i].day)}</text>
      ))}
    </svg>
  );
}

function HeatmapGrid({ heatmap }: { heatmap: Heatmap }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="grid" style={{ gridTemplateColumns: "36px repeat(24, minmax(0, 1fr))" }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-center text-[10px] text-muted-foreground">{h % 3 === 0 ? h : ""}</div>
          ))}
          {heatmap.cells.map((row, d) => (
            <div key={d} className="contents">
              <div className="pr-1 text-right text-[11px] leading-5 text-muted-foreground">{DAYS[d]}</div>
              {row.map((b, h) => (
                <div
                  key={h}
                  className="m-px h-5 rounded-sm"
                  style={{ backgroundColor: b > 0 ? `rgba(124, 58, 237, ${0.12 + 0.88 * (b / heatmap.max)})` : "#f1f5f9" }}
                  title={`${DAYS[d]} ${hourLabel(h)}: ${b > 0 ? gb(b) : "none"}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeviceRow({ d, centerId, onSaved }: { d: WifiDeviceRow; centerId: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.label ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const label = name.trim();
    if (!label) return;
    setSaving(true);
    try {
      const res = await fetch("/api/unifi/device-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: centerId, mac: d.mac, label, contract_id: d.contractId }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save the name");
      toast.success("Device named");
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the name");
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b align-middle last:border-0">
      <td className="py-2 pr-3">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="h-8 w-48" autoFocus onKeyDown={(e) => e.key === "Enter" && save()} aria-label="Device name" />
            <Button size="sm" onClick={save} disabled={saving || !name.trim()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setName(d.label ?? ""); }}>Cancel</Button>
          </div>
        ) : (
          <>
            <div className="font-medium">{d.name}</div>
            <div className="text-xs text-muted-foreground">
              {[d.seat !== null ? `Seat ${d.seat}` : null, d.label && d.memberName ? d.memberName : null, d.hostname && d.hostname !== d.name ? d.hostname : null, d.mac.slice(-8)].filter(Boolean).join(" · ")}
            </div>
          </>
        )}
      </td>
      <td className="py-2 pr-3"><div className="flex flex-wrap gap-1">{d.how.map((h) => <Badge key={h} variant="secondary" className="whitespace-nowrap">{HOW_LABEL[h]}</Badge>)}</div></td>
      <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{d.usage ? gb(d.usage.bytes) : "—"}</td>
      <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{d.usage ? `${d.usage.activeDays} day${d.usage.activeDays === 1 ? "" : "s"}` : "none"}</td>
      <td className="py-2 text-right">{!editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>{d.label ? "Rename" : "Assign name"}</Button>}</td>
    </tr>
  );
}

export function WifiPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<WifiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/wifi`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load Wi-Fi usage");
      setData((await res.json()) as WifiData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Wi-Fi usage");
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
        <Skeleton className="h-20" />
        <Skeleton className="h-48" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load Wi-Fi usage"}</p>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  if (data.status !== "ok" || !data.summary || !data.series || !data.heatmap || !data.devices || !data.center) {
    const msg = NOT_AVAILABLE[data.status === "ok" ? "no_devices" : data.status];
    return (
      <Card>
        <CardContent>
          <EmptyState icon={Wifi} title={msg.title} description={msg.description} />
        </CardContent>
      </Card>
    );
  }

  const { summary, heatmap, devices, center, tags } = data;
  const seatShare = data.seats && data.capacity ? data.seats / data.capacity : null;
  const activeDevices = summary.activeDevices;

  return (
    <div className="space-y-4">
      {data.consoleReachable === false && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The UniFi console could not be reached just now, so devices linked by voucher are missing and only devices named by staff are shown. Usage already recorded is unaffected.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Devices linked" value={String(devices.length)} note={`${activeDevices} used Wi-Fi in the last ${data.windowDays} days${data.seats ? ` · ${data.seats} seat${data.seats === 1 ? "" : "s"}` : ""}`} />
        <Stat label={`Data, last ${data.windowDays} days`} value={summary.bytes > 0 ? gb(summary.bytes) : "—"} note={summary.bytes > 0 ? `${gb(summary.download)} down · ${gb(summary.upload)} up` : undefined} />
        <Stat label="Days active" value={`${summary.activeDays} of ${summary.knownDays}`} note="Days with any use, of the days recorded" />
        <Stat
          label={`Share of ${center.name}`}
          value={summary.centerShare === null ? "—" : `${(summary.centerShare * 100).toFixed(1)}%`}
          note={seatShare !== null ? `Seats are ${(seatShare * 100).toFixed(1)}% of the center` : undefined}
        />
      </div>

      {data.seats !== undefined && data.seats > 0 && devices.length > data.seats && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {devices.length} devices are linked to {data.seats} seat{data.seats === 1 ? "" : "s"}. More devices than seats can mean vouchers are being shared.
        </p>
      )}

      {tags && tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Usage profile</span>
          {tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Data used per day</CardTitle>
          <p className="text-xs text-muted-foreground">Grey bars are days nothing was recorded, which is not the same as no use.</p>
        </CardHeader>
        <CardContent><DailyChart points={data.series} /></CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">When they use it</CardTitle>
          <p className="text-xs text-muted-foreground">
            Local time, darker is more data.
            {heatmap.hoursCovered < 24 * 7 ? ` Based on ${heatmap.hoursCovered} hours recorded so far, so it is still filling in.` : ""}
            {heatmap.afterHoursShare !== null ? ` ${(heatmap.afterHoursShare * 100).toFixed(0)}% of use is outside 07:00 to 21:00 or on Sundays.` : ""}
          </p>
        </CardHeader>
        <CardContent>
          {heatmap.max > 0 ? <HeatmapGrid heatmap={heatmap} /> : <p className="text-sm text-muted-foreground">No hourly usage recorded for these devices yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Devices</CardTitle>
          <p className="text-xs text-muted-foreground">Only deliberately linked devices are counted here. Name a device to make it easy to recognise.</p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Device</th>
                <th className="py-2 pr-3 font-medium">Linked by</th>
                <th className="py-2 pr-3 text-right font-medium">Last {data.windowDays} days</th>
                <th className="py-2 pr-3 text-right font-medium">Active</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {[...devices].sort((a, b) => (b.usage?.bytes ?? -1) - (a.usage?.bytes ?? -1)).map((d) => (
                <DeviceRow key={d.mac} d={d} centerId={center.id} onSaved={load} />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

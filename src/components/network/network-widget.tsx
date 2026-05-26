"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Wifi, Users, MonitorSmartphone, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

interface DashboardData {
  internet: { status: string; latency_ms: number | null; uptime_pct: number };
  live_clients: { total: number; guest: number; staff: number };
  today: { unique_devices: number; wlan_bytes: number; wan_tx: number; wan_rx: number };
}

interface NetworkWidgetProps {
  locationId?: string;
}

export function NetworkWidget({ locationId }: NetworkWidgetProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Check if any UniFi-enabled location exists
    fetch("/api/locations")
      .then((r) => r.json())
      .then((json) => {
        const locations: { id: string; unifi_site_id?: string | null }[] = json.data ?? json ?? [];
        const unifiLocations = locations.filter((l) => l.unifi_site_id);
        if (unifiLocations.length === 0) {
          setVisible(false);
          setLoading(false);
          return;
        }
        setVisible(true);
        const lid = locationId ?? unifiLocations[0].id;
        return fetch(`/api/unifi/dashboard?location_id=${lid}`)
          .then((r) => r.json())
          .then((d) => setData(d))
          .catch(() => {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [locationId]);

  if (!visible || loading) return null;
  if (!data) return null;

  const online = data.internet.status === "online";
  const totalBandwidth = data.today.wan_tx + data.today.wan_rx;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-semibold">
          <span className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-primary" />
            Network
          </span>
          <Link
            href="/network"
            className="text-xs font-medium text-primary hover:underline underline-offset-2"
          >
            View Network →
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Internet status */}
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-2 w-2 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`}
          />
          <span className={`text-sm font-medium ${online ? "text-green-700" : "text-red-600"}`}>
            Internet {online ? "Online" : "Degraded"}
          </span>
          {data.internet.latency_ms != null && (
            <span className="text-xs text-muted-foreground ml-auto">
              {data.internet.latency_ms}ms
            </span>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-muted/50 px-2 py-2">
            <Users className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold leading-none">{data.live_clients.total}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {data.live_clients.staff}s / {data.live_clients.guest}g
            </p>
          </div>
          <div className="rounded-md bg-muted/50 px-2 py-2">
            <MonitorSmartphone className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold leading-none">{data.today.unique_devices}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Devices today</p>
          </div>
          <div className="rounded-md bg-muted/50 px-2 py-2">
            <Activity className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-sm font-bold leading-none">{fmtBytes(totalBandwidth)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Bandwidth</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

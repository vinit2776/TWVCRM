"use client";

import { useEffect, useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ElectricityTelemetryPanel } from "@/components/locations/electricity-telemetry-panel";

interface MeterLocation {
  id: string;
  name: string;
  default_device_id: string | null;
}

interface Props {
  /** The dashboard-wide location filter; the widget follows it when that location has meters. */
  locationFilter: string | null;
}

/**
 * The location page's Live Meter Telemetry panel, on the dashboard. It names the
 * location it is showing and, once more than one location has meters connected,
 * lets the viewer switch between them. With a single location the label is
 * static — there is nothing to choose.
 */
export function MeterTelemetryWidget({ locationFilter }: Props) {
  const [locations, setLocations] = useState<MeterLocation[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/meter-locations")
      .then(async (r) => {
        if (r.status === 403) { if (!cancelled) setForbidden(true); return; }
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!cancelled) setLocations(j.data);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // Follow the dashboard location filter when it points at a metered location;
  // otherwise leave the viewer's own choice alone.
  useEffect(() => {
    if (locationFilter && locations?.some((l) => l.id === locationFilter)) setPicked(locationFilter);
  }, [locationFilter, locations]);

  if (forbidden) return null;

  if (failed) {
    return <Card><CardContent className="py-6 text-sm text-muted-foreground">Couldn&apos;t load meter locations.</CardContent></Card>;
  }
  if (!locations) {
    return <Card><CardContent className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>;
  }
  if (locations.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No location has live meter telemetry switched on yet. Enable it under Locations → Electricity.
        </CardContent>
      </Card>
    );
  }

  const current = locations.find((l) => l.id === picked) ?? locations[0];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm text-muted-foreground">Location</span>
        {locations.length > 1 ? (
          <Select value={current.id} onValueChange={setPicked}>
            <SelectTrigger className="h-9 w-72" aria-label="Meter location">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm font-medium">{current.name}</span>
        )}
      </div>
      {/* Keyed by location so the panel's meter, date range and default-device state reset on a switch. */}
      <ElectricityTelemetryPanel key={current.id} locationId={current.id} defaultDeviceId={current.default_device_id} />
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { Building2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface LocationRow {
  location_id: string;
  location_name: string;
  capacity: number;
  occupied: number;
  vacant: number;
  occupancy_pct: number;
}

interface OccupancyData {
  total_capacity: number;
  total_occupied: number;
  total_vacant: number;
  overall_pct: number;
  locations: LocationRow[];
}

interface OccupancyWidgetProps {
  locationFilter: string | null;
}

function pctColor(pct: number) {
  if (pct >= 85) return "bg-emerald-500";
  if (pct >= 60) return "bg-blue-500";
  if (pct >= 35) return "bg-amber-500";
  return "bg-red-500";
}

export function OccupancyWidget({ locationFilter }: OccupancyWidgetProps) {
  const [data, setData] = useState<OccupancyData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/occupancy?${params}`);
      const json = await res.json();
      setData(json.data ?? null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [locationFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          Occupancy
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.total_capacity === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No active seats configured
          </p>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  Overall
                </span>
                <span className="text-xs text-muted-foreground">
                  {data.total_occupied}/{data.total_capacity} seats
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="text-2xl font-bold">{data.overall_pct}%</span>
                <span className="text-xs text-muted-foreground">
                  {data.total_vacant} vacant
                </span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full ${pctColor(data.overall_pct)} transition-all`}
                  style={{ width: `${data.overall_pct}%` }}
                />
              </div>
            </div>

            {data.locations.length > 1 && (
              <div className="space-y-2 pt-1">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  By location
                </p>
                {data.locations.map((l) => (
                  <div key={l.location_id}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium truncate">{l.location_name}</span>
                      <span className="text-muted-foreground">
                        {l.occupancy_pct}% · {l.occupied}/{l.capacity}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full ${pctColor(l.occupancy_pct)}`}
                        style={{ width: `${l.occupancy_pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

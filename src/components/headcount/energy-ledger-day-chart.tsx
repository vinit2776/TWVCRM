"use client";

import { useEffect, useState } from "react";
import { Loader2, Database, AlertTriangle } from "lucide-react";
import {
  ComposedChart, Bar, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

interface Props {
  locationId: string;
  /** YYYY-MM-DD, IST calendar day */
  date: string;
}

function formatHourTick(ts: number) {
  return new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: true });
}

// Recharts' default Scatter tooltip dumps every field of the hovered point
// (including the raw epoch "ts" used for x-position) — this keeps just the
// two values that are actually meaningful to read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const wh = payload.find((p: { dataKey?: string }) => p.dataKey === "wh");
  const count = payload.find((p: { dataKey?: string }) => p.dataKey === "count");
  return (
    <div className="bg-background border rounded-md shadow-sm px-3 py-2 text-xs space-y-1">
      <p className="font-medium">{formatHourTick(Number(label))}</p>
      {wh && <p>Consumption: {wh.value} Wh</p>}
      {count && <p>Headcount: {count.value}</p>}
    </div>
  );
}

// Renders the same day-shape chart as HeadcountEnergyChart's "day" mode, but
// sourced entirely from the local ledger (location_energy_readings) and the
// headcount log — never a live OneGrid call. Works for any day the ledger
// has been backfilled for (via headcount saves or the manual Sync button),
// including days OneGrid itself may no longer have (its own history has
// already been observed to churn).
export function EnergyLedgerDayChart({ locationId, date }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<{ ts: number; wh: number }[]>([]);
  const [points, setPoints] = useState<{ ts: number; count: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [ledgerRes, hcRes] = await Promise.all([
          fetch(`/api/locations/${locationId}/energy-readings?date=${date}`),
          fetch(`/api/headcount?location_id=${locationId}&from=${date}T00:00:00&to=${date}T23:59:59&limit=200`),
        ]);
        const ledgerJson = await ledgerRes.json();
        const hcJson = await hcRes.json();
        if (!ledgerRes.ok) throw new Error(ledgerJson.error || "Failed to load local ledger");
        if (!hcRes.ok) throw new Error(hcJson.error || "Failed to load headcount");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ledgerRows = ((ledgerJson.data ?? []) as any[])
          .filter((r) => r.energy_delta_wh != null)
          .map((r) => ({ ts: new Date(r.ts).getTime(), wh: Math.round(r.energy_delta_wh) }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hcPoints = ((hcJson.data ?? []) as any[])
          .map((r) => ({ ts: new Date(r.recorded_at).getTime(), count: r.total_count as number }));

        if (!cancelled) { setRows(ledgerRows); setPoints(hcPoints); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [locationId, date]);

  if (loading) {
    return <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return (
      <p className="text-sm text-destructive flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" /> {error}
      </p>
    );
  }
  if (rows.length === 0 && points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing in the local ledger for this day yet — it fills in from headcount saves or the Electricity
        tab&apos;s &quot;Sync to local ledger&quot; button.
      </p>
    );
  }

  // Recharts' "dataMin"/"dataMax" domain keywords don't reliably compute
  // a numeric domain once a <Bar> is mixed with a type="number" axis —
  // every bar and axis tick collapses onto a single x position once there
  // are more than a couple of points. Computing the domain ourselves and
  // passing actual numbers sidesteps whatever's broken in that path.
  const allTs = [...rows.map((r) => r.ts), ...points.map((p) => p.ts)];
  const xDomain: [number, number] = allTs.length
    ? [Math.min(...allTs), Math.max(...allTs)]
    : [0, 1];

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Database className="h-3.5 w-3.5" /> From TWV&apos;s local ledger, not a live OneGrid call
      </p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ left: 4, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts" type="number" domain={xDomain} allowDuplicatedCategory={false}
              tickFormatter={formatHourTick} tick={{ fontSize: 11 }}
            />
            <YAxis yAxisId="wh" tick={{ fontSize: 11 }} width={50} label={{ value: "Wh", angle: -90, position: "insideLeft", fontSize: 11 }} />
            <YAxis yAxisId="hc" orientation="right" tick={{ fontSize: 11 }} width={36} allowDecimals={false} label={{ value: "people", angle: 90, position: "insideRight", fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Bar yAxisId="wh" dataKey="wh" fill="#5DCAA5" maxBarSize={14} name="Consumption (Wh)" />
            <Scatter yAxisId="hc" data={points} dataKey="count" fill="#D85A30" name="Headcount" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

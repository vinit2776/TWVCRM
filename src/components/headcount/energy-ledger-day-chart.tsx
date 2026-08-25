"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Database, AlertTriangle } from "lucide-react";
import {
  ComposedChart, Bar, Scatter, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from "recharts";

interface Props {
  locationId: string;
  /** YYYY-MM-DD, IST calendar day */
  date: string;
}

type Row = { ts: number; wh: number };
type Point = { ts: number; count: number };
type Hover = { ts: number; x: number; y: number };

function formatHourTick(ts: number) {
  return new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: true });
}

const NEARBY_HEADCOUNT_WINDOW_MS = 20 * 60 * 1000; // show a headcount reading if it's within 20 min of the hovered bar

function lookupNearest(rows: Row[], points: Point[], ts: number) {
  const nearestBar = rows.reduce<{ row: Row; dist: number } | null>((best, r) => {
    const dist = Math.abs(r.ts - ts);
    if (dist > NEARBY_HEADCOUNT_WINDOW_MS) return best;
    if (!best || dist < best.dist) return { row: r, dist };
    return best;
  }, null);
  const nearestPoint = points.reduce<{ point: Point; dist: number } | null>((best, p) => {
    const dist = Math.abs(p.ts - ts);
    if (dist > NEARBY_HEADCOUNT_WINDOW_MS) return best;
    if (!best || dist < best.dist) return { point: p, dist };
    return best;
  }, null);
  return { nearestBar, nearestPoint };
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
  const [rows, setRows] = useState<Row[]>([]);
  const [points, setPoints] = useState<Point[]>([]);
  const [hover, setHover] = useState<Hover | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // A day at 15-min resolution can have up to 96 bars. A fixed max width
  // (14px) that made sense for a handful of points overlaps into a solid
  // block once there are dozens — scale it down as point count grows so
  // bars stay visually distinct instead of mashing together.
  const barSize = Math.max(2, Math.min(14, Math.floor(480 / Math.max(rows.length, 1))));

  const { nearestBar, nearestPoint } = hover ? lookupNearest(rows, points, hover.ts) : { nearestBar: null, nearestPoint: null };
  const containerWidth = containerRef.current?.clientWidth ?? 0;
  const flipLeft = hover != null && containerWidth > 0 && hover.x > containerWidth * 0.6;

  // Recharts v3's own activeIndex/activeLabel tracking (both the default
  // <Tooltip> and the chart-level onMouseMove callback) has been confirmed
  // to freeze at the first resolved index for the remainder of a hover
  // session on this Bar+Scatter combo — verified by dispatching mousemove at
  // many different positions and watching activeCoordinate.x update on every
  // call while activeIndex/activeLabel never changed. activeCoordinate.x
  // itself DOES track the real cursor position correctly, so instead of
  // trusting Recharts' snapped label we measure two rendered bars' real
  // screen positions once per hover and linearly invert the cursor's own
  // clientX against them to recover the timestamp ourselves.
  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container || rows.length === 0) return;
    const bars = container.querySelectorAll(".recharts-bar-rectangle path");
    if (bars.length < 2) return;
    const firstRect = bars[0].getBoundingClientRect();
    const lastRect = bars[bars.length - 1].getBoundingClientRect();
    const x0 = firstRect.left + firstRect.width / 2;
    const x1 = lastRect.left + lastRect.width / 2;
    const ts0 = rows[0].ts;
    const ts1 = rows[rows.length - 1].ts;
    if (x1 === x0) return;
    const clampedX = Math.min(Math.max(e.clientX, Math.min(x0, x1)), Math.max(x0, x1));
    const frac = (clampedX - x0) / (x1 - x0);
    const ts = ts0 + frac * (ts1 - ts0);
    const containerRect = container.getBoundingClientRect();
    setHover({ ts, x: e.clientX - containerRect.left, y: e.clientY - containerRect.top });
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Database className="h-3.5 w-3.5" /> From TWV&apos;s local ledger, not a live OneGrid call — hover any bar or dot
      </p>
      <div
        ref={containerRef}
        className="relative h-64"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ left: 4, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts" type="number" domain={xDomain} allowDuplicatedCategory={false}
              tickFormatter={formatHourTick} tick={{ fontSize: 11 }}
            />
            <YAxis yAxisId="wh" tick={{ fontSize: 11 }} width={50} label={{ value: "Wh", angle: -90, position: "insideLeft", fontSize: 11 }} />
            <YAxis yAxisId="hc" orientation="right" tick={{ fontSize: 11 }} width={36} allowDecimals={false} label={{ value: "people", angle: 90, position: "insideRight", fontSize: 11 }} />
            <Bar yAxisId="wh" dataKey="wh" fill="#5DCAA5" barSize={barSize} name="Consumption (Wh)" background={{ fill: "transparent" }} />
            <Scatter yAxisId="hc" data={points} dataKey="count" fill="#D85A30" name="Headcount" />
          </ComposedChart>
        </ResponsiveContainer>
        {hover && (nearestBar || nearestPoint) && (
          <div
            className="pointer-events-none absolute z-10 bg-background border rounded-md shadow-sm px-3 py-2 text-xs space-y-1 whitespace-nowrap"
            style={{
              left: hover.x,
              top: hover.y,
              transform: `translate(${flipLeft ? "-100%" : "0%"}, -110%)`,
            }}
          >
            <p className="font-medium">{formatHourTick(hover.ts)}</p>
            {nearestBar && <p>Consumption: {nearestBar.row.wh} Wh ({formatHourTick(nearestBar.row.ts)})</p>}
            {nearestPoint && <p>Headcount: {nearestPoint.point.count} (logged {formatHourTick(nearestPoint.point.ts)})</p>}
          </div>
        )}
      </div>
    </div>
  );
}

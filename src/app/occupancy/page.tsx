"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";

// ── Types ──────────────────────────────────────────────────────────────────────

type LocationOccupancy = {
  name: string;
  inside: number;
  capacity: number;
  pct: number | null;
  by_type: Record<string, number>;
};

type OccupancyData = {
  total_inside: number;
  total_capacity: number;
  by_type: Record<string, number>;
  locations: LocationOccupancy[];
  updated_at: string;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  contract: "Members",
  member:   "Seat Holders",
  employee: "Staff",
  booking:  "Walk-ins",
};

const TYPE_COLORS: Record<string, string> = {
  contract: "#60a5fa",  // blue-400
  member:   "#c084fc",  // purple-400
  employee: "#4ade80",  // green-400
  booking:  "#fbbf24",  // amber-400
};

const REFRESH_INTERVAL = 30_000; // 30 seconds

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function pctColor(pct: number | null): string {
  if (pct === null) return "#64748b";
  if (pct >= 85) return "#f87171"; // red
  if (pct >= 60) return "#fbbf24"; // amber
  return "#4ade80";                // green
}

// ── Inner component (uses useSearchParams) ─────────────────────────────────────

function OccupancyDisplay() {
  const searchParams = useSearchParams();
  const locationId   = searchParams.get("location_id");
  const theme        = searchParams.get("theme") ?? "dark"; // dark | light

  const [data, setData]     = useState<OccupancyData | null>(null);
  const [tick, setTick]     = useState(0);   // countdown seconds
  const intervalRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef             = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const qs = locationId ? `?location_id=${locationId}` : "";
    try {
      const res  = await fetch(`/api/public/occupancy${qs}`, { cache: "no-store" });
      const json = await res.json() as OccupancyData;
      setData(json);
      setTick(REFRESH_INTERVAL / 1000);
    } catch { /* network blip — keep showing last data */ }
  }, [locationId]);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, REFRESH_INTERVAL);
    tickRef.current     = setInterval(() => setTick(t => Math.max(0, t - 1)), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (tickRef.current)     clearInterval(tickRef.current);
    };
  }, [load]);

  const isDark = theme !== "light";

  const bg      = isDark ? "bg-gray-950"    : "bg-slate-50";
  const cardBg  = isDark ? "bg-gray-900"    : "bg-white";
  const border  = isDark ? "border-gray-800" : "border-slate-200";
  const text     = isDark ? "text-white"     : "text-slate-900";
  const subtext  = isDark ? "text-gray-400"  : "text-slate-500";

  if (!data) {
    return (
      <div className={`min-h-screen ${bg} flex items-center justify-center`}>
        <div className={`text-2xl font-light ${subtext} animate-pulse`}>Loading occupancy…</div>
      </div>
    );
  }

  const hasCapacity = data.total_capacity > 0;
  const globalPct   = hasCapacity ? Math.round((data.total_inside / data.total_capacity) * 100) : null;
  const typeEntries = Object.entries(data.by_type).filter(([, v]) => v > 0);
  // Show per-location breakdown only if multiple locations
  const multiLoc    = data.locations.length > 1;

  return (
    <div className={`min-h-screen ${bg} ${text} flex flex-col p-6 md:p-10 gap-6 font-sans`}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <p className={`text-xs uppercase tracking-widest font-semibold ${subtext}`}>
            The Work Villa
          </p>
          <h1 className="text-lg font-semibold mt-0.5">Live Occupancy</h1>
        </div>
        <div className={`text-xs ${subtext} text-right`}>
          <p>Updated {fmtTime(data.updated_at)}</p>
          <p className="mt-0.5 tabular-nums">Next refresh in {tick}s</p>
        </div>
      </div>

      {/* ── Hero — total count ───────────────────────────────────────────────── */}
      <div className={`rounded-2xl border ${cardBg} ${border} p-8 md:p-12 flex flex-col md:flex-row items-center md:items-end gap-6 md:gap-12`}>

        {/* Big number */}
        <div className="text-center md:text-left">
          <p className={`text-xs uppercase tracking-widest font-medium ${subtext} mb-1`}>Inside Right Now</p>
          <p
            className="text-8xl md:text-[10rem] font-bold leading-none tabular-nums"
            style={{ color: globalPct !== null ? pctColor(globalPct) : undefined }}
          >
            {data.total_inside}
          </p>
          {hasCapacity && (
            <p className={`text-lg ${subtext} mt-2`}>
              of {data.total_capacity} seats
              {globalPct !== null && (
                <span
                  className="ml-3 font-semibold"
                  style={{ color: pctColor(globalPct) }}
                >
                  {globalPct}% full
                </span>
              )}
            </p>
          )}
        </div>

        {/* Capacity bar */}
        {hasCapacity && (
          <div className="flex-1 w-full md:max-w-xs">
            <div className={`w-full h-4 rounded-full ${isDark ? "bg-gray-800" : "bg-slate-200"} overflow-hidden`}>
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min(globalPct ?? 0, 100)}%`,
                  backgroundColor: pctColor(globalPct),
                }}
              />
            </div>
            <div className={`flex justify-between text-xs ${subtext} mt-1.5`}>
              <span>0</span>
              <span>{data.total_capacity}</span>
            </div>
          </div>
        )}

        {/* By-type pills */}
        {typeEntries.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-center md:justify-start">
            {typeEntries.map(([type, count]) => (
              <div
                key={type}
                className={`rounded-xl px-4 py-2 text-center min-w-[80px] ${isDark ? "bg-gray-800" : "bg-slate-100"}`}
              >
                <p className="text-2xl font-bold tabular-nums" style={{ color: TYPE_COLORS[type] ?? "#94a3b8" }}>
                  {count}
                </p>
                <p className={`text-xs mt-0.5 ${subtext}`}>{TYPE_LABELS[type] ?? type}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Per-location grid (only when multiple locations) ─────────────────── */}
      {multiLoc && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.locations.map((loc) => (
            <div key={loc.name} className={`rounded-xl border ${cardBg} ${border} p-5`}>
              <p className={`text-xs font-medium uppercase tracking-wide ${subtext} mb-3`}>{loc.name}</p>
              <div className="flex items-end gap-3">
                <p
                  className="text-5xl font-bold tabular-nums leading-none"
                  style={{ color: pctColor(loc.pct) }}
                >
                  {loc.inside}
                </p>
                {loc.capacity > 0 && (
                  <p className={`text-sm ${subtext} pb-1`}>/ {loc.capacity}</p>
                )}
              </div>
              {loc.capacity > 0 && loc.pct !== null && (
                <div className="mt-3">
                  <div className={`w-full h-2 rounded-full ${isDark ? "bg-gray-800" : "bg-slate-200"} overflow-hidden`}>
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{
                        width: `${Math.min(loc.pct, 100)}%`,
                        backgroundColor: pctColor(loc.pct),
                      }}
                    />
                  </div>
                  <p className={`text-xs ${subtext} mt-1`}>{loc.pct}% occupied</p>
                </div>
              )}
              {/* Per-location type breakdown */}
              {Object.keys(loc.by_type).length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {Object.entries(loc.by_type).map(([type, count]) => (
                    <span
                      key={type}
                      className={`text-xs px-2 py-0.5 rounded-full ${isDark ? "bg-gray-800" : "bg-slate-100"}`}
                      style={{ color: TYPE_COLORS[type] ?? "#94a3b8" }}
                    >
                      {count} {TYPE_LABELS[type] ?? type}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Footer note ──────────────────────────────────────────────────────── */}
      <p className={`text-xs ${subtext} text-center mt-auto pt-4`}>
        Entry sensor only — exit may lag by up to 5 minutes · Auto-refreshes every 30 seconds
      </p>

    </div>
  );
}

// ── Page wrapper (Suspense required for useSearchParams) ───────────────────────

export default function OccupancyPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <p className="text-gray-400 text-xl animate-pulse">Loading…</p>
      </div>
    }>
      <OccupancyDisplay />
    </Suspense>
  );
}

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Users, Plus, ChevronLeft, ChevronRight, Trash2, History, ClipboardEdit,
  MapPin, Navigation, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { useLocations } from "@/hooks/use-locations";
import { toast } from "sonner";
import { cn, formatDate } from "@/lib/utils";
import type { SpaceHeadcount, LocationCapacityConfig } from "@/types";

// ─── Constants ──────────────────────────────────────────────────────────────

const AREA_TYPES: { key: keyof LocationCapacityConfig; label: string; emoji: string }[] = [
  { key: "open_desk",       label: "Open Desk",       emoji: "💺" },
  { key: "private_cabin",   label: "Private Cabin",   emoji: "🏢" },
  { key: "meeting_room",    label: "Meeting Room",    emoji: "📋" },
  { key: "conference_room", label: "Conference Room", emoji: "🎯" },
];

const ROLES_CAN_ENTER = ["admin", "manager", "floor_manager", "office_admin"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true });
}

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

function toLocalDatetimeInput(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function calcUtilPct(count: number | null | undefined, capacity: number | undefined) {
  if (!count || !capacity || capacity === 0) return null;
  return Math.min(100, Math.round((count / capacity) * 100));
}

function utilColor(pct: number | null) {
  if (pct === null) return "bg-gray-200";
  if (pct >= 90) return "bg-red-500";
  if (pct >= 60) return "bg-amber-400";
  return "bg-[#015E65]";
}

// Haversine distance in metres between two lat/lng pairs
function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m away` : `${(m / 1000).toFixed(1)} km away`;
}

const GEO_AUTO_SELECT_THRESHOLD_M = 500; // metres

// ─── Sub-components ──────────────────────────────────────────────────────────

function UtilBar({ label, emoji, count, capacity }: {
  label: string; emoji: string; count?: number | null; capacity?: number;
}) {
  const pct = calcUtilPct(count, capacity);
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground mb-1">
        <span>{emoji} {label}</span>
        <span className="font-medium">{count ?? "—"}{capacity ? ` / ${capacity}` : ""}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", utilColor(pct))}
          style={{ width: pct !== null ? `${pct}%` : "0%" }} />
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function HeadcountPage() {
  const { locations } = useLocations(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"entry" | "history">("entry");

  // ── Entry state ──
  const [locationId, setLocationId] = useState("");
  const [recordedAt, setRecordedAt] = useState(toLocalDatetimeInput());
  const [areas, setAreas] = useState<Record<string, string>>({});
  const [totalCount, setTotalCount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // ── Geolocation suggestion ──
  type GeoSuggestion = { locationId: string; name: string; distanceM: number } | null;
  const [geoStatus, setGeoStatus] = useState<"idle" | "detecting" | "done" | "denied" | "unavailable">("idle");
  const [geoSuggestion, setGeoSuggestion] = useState<GeoSuggestion>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);

  // ── Today's readings (right panel) ──
  const [todayReadings, setTodayReadings] = useState<SpaceHeadcount[]>([]);
  const [todayLoading, setTodayLoading] = useState(false);

  // ── History state ──
  const [historyRows, setHistoryRows] = useState<SpaceHeadcount[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPages, setHistoryPages] = useState(1);
  const [filterLocation, setFilterLocation] = useState("__all");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const HISTORY_LIMIT = 20;

  // ── Resolve user role ──
  useEffect(() => {
    fetch("/api/me").then(r => r.json()).then(j => setUserRole(j.role || null)).catch(() => {});
  }, []);

  // ── Geolocation detection — runs once when locations are loaded ──
  useEffect(() => {
    if (locations.length === 0 || geoStatus !== "idle") return;

    if (!navigator.geolocation) {
      setGeoStatus("unavailable");
      if (locations.length > 0 && !locationId) setLocationId(locations[0].id);
      return;
    }

    setGeoStatus("detecting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: userLat, longitude: userLng } = pos.coords;

        // Find nearest location that has coordinates stored
        let nearest: GeoSuggestion = null;
        let nearestDist = Infinity;
        for (const loc of locations) {
          if (loc.latitude == null || loc.longitude == null) continue;
          const d = distanceMetres(userLat, userLng, loc.latitude, loc.longitude);
          if (d < nearestDist) { nearestDist = d; nearest = { locationId: loc.id, name: loc.name, distanceM: d }; }
        }

        setGeoStatus("done");
        if (nearest && nearest.distanceM <= GEO_AUTO_SELECT_THRESHOLD_M) {
          setGeoSuggestion(nearest);
          // Don't auto-select — show suggestion card and wait for user to confirm
        } else {
          // Outside threshold or no coords on any location — fall back to first
          if (!locationId && locations.length > 0) setLocationId(locations[0].id);
        }
      },
      () => {
        setGeoStatus("denied");
        if (!locationId && locations.length > 0) setLocationId(locations[0].id);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations]);

  const selectedLocation = useMemo(
    () => locations.find(l => l.id === locationId) ?? null,
    [locations, locationId]
  );
  const capacity = selectedLocation?.capacity_config ?? {};

  // Auto-sum area counts → total
  const autoSum = useMemo(() => {
    return AREA_TYPES.reduce((sum, a) => {
      const v = parseInt(areas[a.key] ?? "");
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
  }, [areas]);

  // Keep total in sync with auto-sum unless user overrides
  const [totalOverridden, setTotalOverridden] = useState(false);
  useEffect(() => {
    if (!totalOverridden && autoSum > 0) setTotalCount(String(autoSum));
  }, [autoSum, totalOverridden]);

  // ── Load today's readings ──
  const loadTodayReadings = useCallback(async () => {
    if (!locationId) return;
    setTodayLoading(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      const res = await fetch(
        `/api/headcount?location_id=${locationId}&from=${today}T00:00:00&to=${today}T23:59:59&limit=10`
      );
      const json = await res.json();
      if (res.ok) setTodayReadings(json.data || []);
    } finally {
      setTodayLoading(false);
    }
  }, [locationId]);

  useEffect(() => { loadTodayReadings(); }, [loadTodayReadings]);

  // ── Load history ──
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(HISTORY_LIMIT),
        page: String(historyPage),
      });
      if (filterLocation !== "__all") params.set("location_id", filterLocation);
      if (filterFrom) params.set("from", filterFrom + "T00:00:00");
      if (filterTo)   params.set("to",   filterTo   + "T23:59:59");

      const res = await fetch(`/api/headcount?${params}`);
      const json = await res.json();
      if (res.ok) {
        setHistoryRows(json.data || []);
        setHistoryTotal(json.pagination?.total ?? 0);
        setHistoryPages(json.pagination?.totalPages ?? 1);
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [historyPage, filterLocation, filterFrom, filterTo]);

  useEffect(() => {
    if (activeTab === "history") loadHistory();
  }, [activeTab, loadHistory]);

  // ── Submit entry ──
  const handleSubmit = async () => {
    const total = parseInt(totalCount);
    if (!locationId) { toast.error("Select a location"); return; }
    if (isNaN(total) || total < 0) { toast.error("Enter a valid total count"); return; }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        location_id: locationId,
        recorded_at: new Date(recordedAt).toISOString(),
        total_count: total,
        notes: notes.trim() || null,
      };
      for (const a of AREA_TYPES) {
        const v = parseInt(areas[a.key] ?? "");
        payload[a.key] = isNaN(v) ? null : v;
      }

      const res = await fetch("/api/headcount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save"); return; }

      toast.success("Headcount reading saved");
      // Reset form
      setAreas({});
      setTotalCount("");
      setNotes("");
      setTotalOverridden(false);
      setRecordedAt(toLocalDatetimeInput());
      loadTodayReadings();
    } catch {
      toast.error("Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Delete entry ──
  const handleDelete = async (id: string) => {
    if (!confirm("Delete this headcount reading?")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/headcount/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Reading deleted");
        loadHistory();
        loadTodayReadings();
      } else {
        const json = await res.json();
        toast.error(json.error || "Failed to delete");
      }
    } finally {
      setDeletingId(null);
    }
  };

  const canEnter  = userRole && ROLES_CAN_ENTER.includes(userRole);
  const canDelete = userRole && ["admin", "manager"].includes(userRole);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Headcount</h1>
        <p className="text-sm text-muted-foreground">Log and track occupancy readings throughout the day</p>
      </div>

      {/* Tabs */}
      <div className="bg-muted rounded-lg p-1 flex gap-1 w-fit">
        <button
          onClick={() => setActiveTab("entry")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all",
            activeTab === "entry"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <ClipboardEdit className="h-4 w-4" />
          Log Entry
        </button>
        <button
          onClick={() => setActiveTab("history")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all",
            activeTab === "history"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <History className="h-4 w-4" />
          History
        </button>
      </div>

      {/* ═══ LOG ENTRY TAB ════════════════════════════════════════════════ */}
      {activeTab === "entry" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ── Form ── */}
          <div className="lg:col-span-2 bg-card rounded-xl border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <h2 className="font-semibold">New Headcount Reading</h2>
              <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md border">
                {new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" })}
              </span>
            </div>

            <div className="p-5 space-y-5">

              {/* ── Geolocation suggestion banner ── */}
              {geoStatus === "detecting" && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 border rounded-lg px-3 py-2.5">
                  <span className="h-3.5 w-3.5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin shrink-0" />
                  Detecting your location…
                </div>
              )}

              {geoSuggestion && !suggestionDismissed && !locationId && (
                <div className="flex items-start gap-3 bg-[#015E65]/5 border border-[#015E65]/25 rounded-lg px-4 py-3">
                  <Navigation className="h-4 w-4 text-[#015E65] mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[#015E65]">
                      You appear to be at <strong>{geoSuggestion.name}</strong>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDistance(geoSuggestion.distanceM)} · Tap below to use this location
                    </p>
                    <div className="flex gap-2 mt-2.5">
                      <Button
                        type="button"
                        size="sm"
                        className="bg-[#015E65] hover:bg-[#014a50] text-white h-8 px-4 text-xs"
                        onClick={() => {
                          setLocationId(geoSuggestion.locationId);
                          setSuggestionDismissed(true);
                        }}
                      >
                        <MapPin className="h-3.5 w-3.5 mr-1.5" />
                        Yes, use {geoSuggestion.name}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-3 text-xs text-muted-foreground"
                        onClick={() => {
                          setSuggestionDismissed(true);
                          if (locations.length > 0 && !locationId) setLocationId(locations[0].id);
                        }}
                      >
                        <X className="h-3.5 w-3.5 mr-1" />
                        Different location
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Location + Date/Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Location *</Label>
                  <Select value={locationId} onValueChange={v => { setLocationId(v); setAreas({}); setTotalCount(""); setTotalOverridden(false); setSuggestionDismissed(true); }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select location" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map(l => (
                        <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Date &amp; Time *</Label>
                  <Input
                    type="datetime-local"
                    value={recordedAt}
                    onChange={e => setRecordedAt(e.target.value)}
                  />
                </div>
              </div>

              {/* Area breakdown */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Area Breakdown</p>
                  <Badge variant="outline" className="text-xs font-normal text-muted-foreground">optional</Badge>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {AREA_TYPES.map(a => {
                    const cap = capacity[a.key];
                    const val = parseInt(areas[a.key] ?? "");
                    const pct = calcUtilPct(val, cap);
                    return (
                      <div key={a.key} className="bg-muted/40 rounded-lg p-3 border border-border/60">
                        <div className="flex items-center gap-1.5 mb-2">
                          <span className="text-base">{a.emoji}</span>
                          <span className="text-xs font-medium text-foreground">{a.label}</span>
                          {cap && <span className="ml-auto text-xs text-muted-foreground">cap: {cap}</span>}
                        </div>
                        <Input
                          type="number"
                          min={0}
                          max={cap ?? undefined}
                          placeholder="—"
                          value={areas[a.key] ?? ""}
                          onChange={e => {
                            setAreas(prev => ({ ...prev, [a.key]: e.target.value }));
                            setTotalOverridden(false);
                          }}
                          className="text-center text-lg font-semibold h-10"
                        />
                        {cap && !isNaN(val) && val >= 0 && (
                          <div className="mt-2">
                            <div className="h-1 bg-background rounded-full overflow-hidden">
                              <div className={cn("h-full rounded-full transition-all", utilColor(pct))}
                                style={{ width: `${pct ?? 0}%` }} />
                            </div>
                            <p className="text-xs text-muted-foreground text-right mt-0.5">{pct ?? 0}%</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Total count */}
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-semibold text-primary mb-0.5">
                    Total People in Space *
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Overall occupancy count. Auto-summed from above, or enter directly.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {autoSum > 0 && (
                    <span className="text-xs text-muted-foreground bg-background border rounded px-2 py-1">
                      auto: {autoSum}
                    </span>
                  )}
                  <Input
                    type="number"
                    min={0}
                    value={totalCount}
                    onChange={e => { setTotalCount(e.target.value); setTotalOverridden(true); }}
                    className="w-20 text-center text-xl font-bold border-2 border-primary text-primary"
                  />
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label>Notes <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="e.g. High footfall due to event, conference room fully booked..."
                  rows={2}
                  className="resize-none"
                />
              </div>

              {!canEnter && (
                <p className="text-sm text-muted-foreground bg-muted rounded-lg p-3">
                  You have view-only access to headcount data.
                </p>
              )}

              <Button
                onClick={handleSubmit}
                disabled={submitting || !canEnter || !locationId || !totalCount}
                className="w-full bg-[#015E65] hover:bg-[#014a50] text-white"
                size="lg"
              >
                {submitting ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Saving...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    Save Headcount Reading
                  </span>
                )}
              </Button>
            </div>
          </div>

          {/* ── Right panel: Today's readings + utilisation ── */}
          <div className="space-y-4">
            {/* Today's readings */}
            <div className="bg-card rounded-xl border shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b">
                <h3 className="text-sm font-semibold">Today&apos;s Readings</h3>
                {selectedLocation && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {selectedLocation.name} · {new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}
                  </p>
                )}
              </div>
              {todayLoading ? (
                <div className="p-4 space-y-3">
                  {[1,2].map(i => (
                    <div key={i} className="h-10 bg-muted rounded animate-pulse" />
                  ))}
                </div>
              ) : todayReadings.length === 0 ? (
                <div className="p-6 text-center">
                  <p className="text-sm text-muted-foreground">No readings today yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Log your first reading above</p>
                </div>
              ) : (
                <div className="divide-y">
                  {todayReadings.map(r => (
                    <div key={r.id} className="px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{formatTime(r.recorded_at)}</p>
                        <p className="text-xs text-muted-foreground">{r.recorder?.full_name ?? "Unknown"}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-foreground">{r.total_count}</p>
                        <p className="text-xs text-muted-foreground">people</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Current utilisation — shown once a location with capacity is selected */}
            {selectedLocation && Object.keys(capacity).length > 0 && (
              <div className="bg-card rounded-xl border shadow-sm p-4 space-y-3">
                <p className="text-sm font-semibold">Space Capacity</p>
                {AREA_TYPES.filter(a => capacity[a.key]).map(a => {
                  const latestVal = todayReadings[0]?.[a.key as keyof SpaceHeadcount] as number | null;
                  return (
                    <UtilBar
                      key={a.key}
                      label={a.label}
                      emoji={a.emoji}
                      count={latestVal}
                      capacity={capacity[a.key]}
                    />
                  );
                })}
                <div className="pt-2 border-t flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Total capacity</span>
                  <span className="text-sm font-bold">
                    {Object.values(capacity).reduce((s, v) => s + (v ?? 0), 0)} seats
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ HISTORY TAB ═══════════════════════════════════════════════════ */}
      {activeTab === "history" && (
        <div className="bg-card rounded-xl border shadow-sm overflow-hidden">
          {/* Filters */}
          <div className="px-4 py-3 border-b flex flex-wrap items-center gap-3">
            <Select value={filterLocation} onValueChange={v => { setFilterLocation(v); setHistoryPage(1); }}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All Locations</SelectItem>
                {locations.map(l => (
                  <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Input type="date" value={filterFrom}
                onChange={e => { setFilterFrom(e.target.value); setHistoryPage(1); }}
                className="w-36" />
              <span className="text-muted-foreground">—</span>
              <Input type="date" value={filterTo}
                onChange={e => { setFilterTo(e.target.value); setHistoryPage(1); }}
                className="w-36" />
            </div>
            <Button variant="outline" size="sm" onClick={loadHistory}>Apply</Button>
            {(filterFrom || filterTo || filterLocation !== "__all") && (
              <Button variant="ghost" size="sm" onClick={() => {
                setFilterFrom(""); setFilterTo(""); setFilterLocation("__all"); setHistoryPage(1);
              }}>
                Clear
              </Button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {historyTotal} {historyTotal === 1 ? "entry" : "entries"}
            </span>
          </div>

          {/* Table */}
          {historyLoading ? (
            <div className="p-4"><TableSkeleton rows={5} /></div>
          ) : historyRows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No headcount readings"
              description="Readings logged by your team will appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">Date &amp; Time</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Location</th>
                    {AREA_TYPES.map(a => (
                      <th key={a.key} className="text-center px-3 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        {a.emoji} {a.label.split(" ")[0]}
                      </th>
                    ))}
                    <th className="text-center px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Logged by</th>
                    {canDelete && <th className="px-4 py-3 w-10" />}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {historyRows.map(r => {
                    const loc = r.location;
                    const cap = (loc as { capacity_config?: LocationCapacityConfig })?.capacity_config ?? {};
                    const totalPct = calcUtilPct(r.total_count, Object.values(cap).reduce((s, v) => s + (v ?? 0), 0) || undefined);
                    return (
                      <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-medium text-sm">{formatDateShort(r.recorded_at)}</p>
                          <p className="text-xs text-muted-foreground">{formatTime(r.recorded_at)}</p>
                        </td>
                        <td className="px-4 py-3 text-sm text-foreground">
                          {(r.location as { name?: string })?.name ?? "—"}
                        </td>
                        {AREA_TYPES.map(a => (
                          <td key={a.key} className="px-3 py-3 text-center text-sm font-medium">
                            {r[a.key as keyof SpaceHeadcount] != null ? String(r[a.key as keyof SpaceHeadcount]) : <span className="text-muted-foreground">—</span>}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-center">
                          <span className={cn(
                            "inline-flex items-center justify-center w-10 h-10 rounded-full text-sm font-bold",
                            totalPct !== null && totalPct >= 90 ? "bg-red-50 text-red-700 border border-red-100" :
                            totalPct !== null && totalPct >= 60 ? "bg-amber-50 text-amber-700 border border-amber-100" :
                            "bg-[#015E65]/10 text-[#015E65] border border-[#015E65]/20"
                          )}>
                            {r.total_count}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {(r.recorder as { full_name?: string })?.full_name?.split(" ")[0] ?? "—"}
                        </td>
                        {canDelete && (
                          <td className="px-4 py-3">
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              disabled={deletingId === r.id}
                              onClick={() => handleDelete(r.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {historyPages > 1 && (
            <div className="px-4 py-3 border-t flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Page {historyPage} of {historyPages} · {historyTotal} total
              </p>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" disabled={historyPage <= 1}
                  onClick={() => setHistoryPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" />Prev
                </Button>
                <Button variant="outline" size="sm" disabled={historyPage >= historyPages}
                  onClick={() => setHistoryPage(p => p + 1)}>
                  Next<ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

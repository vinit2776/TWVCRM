"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users, RefreshCw, Download, AlertTriangle, Building2,
  Phone, Clock, Fingerprint, ShieldCheck, Flame,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// ── Types ──────────────────────────────────────────────────────────────────────

type Location = { id: string; name: string };

type PersonInside = {
  entity_id: string;
  entity_name: string;
  user_type: "contract" | "employee" | "booking" | "member";
  phone: string | null;
  department: string | null;
  designation: string | null;
  last_entry_at: string | null;
  location_id: string | null;
  location_name: string | null;
  device_label: string | null;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  contract: "Member",
  member:   "Seat Holder",
  employee: "Employee",
  booking:  "Walk-in",
};

const TYPE_COLOR: Record<string, string> = {
  contract: "bg-blue-100 text-blue-700",
  member:   "bg-purple-100 text-purple-700",
  employee: "bg-green-100 text-green-700",
  booking:  "bg-amber-100 text-amber-700",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit",
  });
}

function minutesSince(iso: string | null): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

function exportCsv(people: PersonInside[], locationLabel: string) {
  const header = ["Name", "Type", "Phone", "Department", "Designation", "Entry Time", "Location", "Device"];
  const rows = people.map(p => [
    p.entity_name,
    TYPE_LABEL[p.user_type] ?? p.user_type,
    p.phone ?? "",
    p.department ?? "",
    p.designation ?? "",
    p.last_entry_at ? new Date(p.last_entry_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
    p.location_name ?? "",
    p.device_label ?? "",
  ]);
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `TWV_Headcount_${locationLabel}_${new Date().toISOString().slice(0, 16).replace("T", "_")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function LiveHeadcountPage() {
  const supabase = createClient();

  const [locations, setLocations]       = useState<Location[]>([]);
  const [locationId, setLocationId]     = useState<string>("__all");
  const [people, setPeople]             = useState<PersonInside[]>([]);
  const [loading, setLoading]           = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh]   = useState(true);
  const [fireDrillMode, setFireDrillMode] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load locations once
  useEffect(() => {
    supabase.from("locations").select("id, name").order("name")
      .then(({ data }) => setLocations(data ?? []));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const loc = locationId !== "__all" ? `?location_id=${locationId}` : "";
      const res = await fetch(`/api/cosec/live-headcount${loc}`);
      const json = await res.json();
      setPeople(json.data ?? []);
      setLastRefreshed(new Date());
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  // Initial load + location change
  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoRefresh) {
      timerRef.current = setInterval(load, 30_000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, load]);

  // ── Derived counts ──────────────────────────────────────────────────────────

  const byType = {
    employee: people.filter(p => p.user_type === "employee").length,
    contract: people.filter(p => p.user_type === "contract").length,
    member:   people.filter(p => p.user_type === "member").length,
    booking:  people.filter(p => p.user_type === "booking").length,
  };

  const locationLabel = locationId === "__all"
    ? "All Locations"
    : (locations.find(l => l.id === locationId)?.name ?? "Unknown");

  // People inside > 8 hours (potential anomaly)
  const longStay = people.filter(p => minutesSince(p.last_entry_at) > 8 * 60);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Users size={20} />
            Live Headcount
            {fireDrillMode && (
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-red-600 bg-red-50 border border-red-200 rounded-full px-3 py-0.5 animate-pulse">
                <Flame size={13} /> FIRE DRILL / EMERGENCY
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Who is inside right now — updated from COSEC access logs
            {lastRefreshed && (
              <span className="ml-2 text-xs">
                · Last refreshed {lastRefreshed.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="All Locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All Locations</SelectItem>
              {locations.map(l => (
                <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm" variant="outline" className="h-8"
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? "Auto-refresh ON — click to pause" : "Auto-refresh OFF — click to enable"}
          >
            <RefreshCw size={13} className={autoRefresh ? "text-green-600 mr-1" : "text-muted-foreground mr-1"} />
            {autoRefresh ? "Live" : "Paused"}
          </Button>

          <Button size="sm" variant="outline" className="h-8" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </Button>

          <Button
            size="sm" variant="outline" className="h-8"
            onClick={() => exportCsv(people, locationLabel)}
            disabled={people.length === 0}
            title="Download CSV with names + phone numbers"
          >
            <Download size={13} className="mr-1" /> Export
          </Button>

          <Button
            size="sm"
            variant={fireDrillMode ? "destructive" : "outline"}
            className={`h-8 ${fireDrillMode ? "" : "border-red-300 text-red-600 hover:bg-red-50"}`}
            onClick={() => setFireDrillMode(v => !v)}
          >
            <Flame size={13} className="mr-1" />
            {fireDrillMode ? "Exit Fire Drill" : "Fire Drill"}
          </Button>
        </div>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="sm:col-span-1 bg-slate-50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Inside</p>
            <p className="text-3xl font-bold">{people.length}</p>
          </CardContent>
        </Card>
        {(["employee", "contract", "member", "booking"] as const).map(type => (
          <Card key={type}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">{TYPE_LABEL[type]}s</p>
              <p className="text-2xl font-semibold">{byType[type]}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Long-stay anomaly banner ────────────────────────────────────────── */}
      {longStay.length > 0 && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>
            <strong>{longStay.length} {longStay.length === 1 ? "person has" : "people have"} been inside for over 8 hours</strong>
            {" — "}{longStay.map(p => p.entity_name).join(", ")}.
            Presence sensor only reads entry — they may have exited without the exit button being logged.
          </span>
        </div>
      )}

      {/* ── Fire drill mode — contact list ─────────────────────────────────── */}
      {fireDrillMode && (
        <Card className="border-red-300 bg-red-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-red-700 flex items-center gap-2">
              <Flame size={14} /> Emergency Contact List — {people.length} inside at {locationLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {people.length === 0 ? (
              <p className="text-sm text-red-600 px-4 pb-4">No one currently logged as inside.</p>
            ) : (
              <div className="divide-y divide-red-200 max-h-80 overflow-y-auto">
                {people.map((p, i) => (
                  <div key={p.entity_id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-red-400 w-5 shrink-0">{i + 1}.</span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-red-900 truncate">{p.entity_name}</p>
                        <p className="text-xs text-red-600">
                          {TYPE_LABEL[p.user_type]}
                          {p.department && ` · ${p.department}`}
                          {" · in since "}{fmtTime(p.last_entry_at)}
                        </p>
                      </div>
                    </div>
                    {p.phone ? (
                      <a
                        href={`tel:${p.phone}`}
                        className="flex items-center gap-1 text-sm font-mono text-red-700 hover:underline shrink-0"
                      >
                        <Phone size={12} /> {p.phone}
                      </a>
                    ) : (
                      <span className="text-xs text-red-400 italic shrink-0">No phone</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Main table ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Fingerprint size={14} />
            {people.length === 0 ? "Nobody inside right now" : `${people.length} inside — ${locationLabel}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {people.length === 0 ? (
            <p className="text-sm text-muted-foreground px-4 pb-4">
              {loading ? "Loading…" : "No one is currently logged as inside. Either the space is empty or COSEC polling hasn't run yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Name</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Type</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs hidden sm:table-cell">Dept / Role</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Entry</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs hidden md:table-cell">Location</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Phone</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {people.map(p => {
                    const mins = minutesSince(p.last_entry_at);
                    const isLong = mins > 8 * 60;
                    return (
                      <tr key={p.entity_id} className={`hover:bg-muted/30 transition-colors ${isLong ? "bg-amber-50" : ""}`}>
                        <td className="px-4 py-2.5">
                          <p className="font-medium truncate max-w-[180px]">{p.entity_name}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge
                            variant="outline"
                            className={`text-xs ${TYPE_COLOR[p.user_type] ?? "bg-gray-100 text-gray-600"}`}
                          >
                            {TYPE_LABEL[p.user_type] ?? p.user_type}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground hidden sm:table-cell">
                          {p.department && <span>{p.department}</span>}
                          {p.designation && <span className="ml-1 text-slate-400">· {p.designation}</span>}
                          {!p.department && !p.designation && "—"}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          <span className={`flex items-center gap-1 ${isLong ? "text-amber-600 font-medium" : "text-muted-foreground"}`}>
                            <Clock size={11} />
                            {fmtTime(p.last_entry_at)}
                            {isLong && <span className="ml-1">(8h+)</span>}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground hidden md:table-cell">
                          <span className="flex items-center gap-1">
                            <Building2 size={11} />
                            {p.location_name ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {p.phone ? (
                            <a
                              href={`tel:${p.phone}`}
                              className="flex items-center gap-1 text-blue-600 hover:underline font-mono"
                            >
                              <Phone size={11} /> {p.phone}
                            </a>
                          ) : (
                            <span className="text-muted-foreground italic">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Per-location breakdown (only shown for All Locations) ────────────── */}
      {locationId === "__all" && people.length > 0 && (() => {
        const byLoc = new Map<string, { name: string; count: number }>();
        for (const p of people) {
          const locId = p.location_id ?? "__unknown";
          if (!byLoc.has(locId)) byLoc.set(locId, { name: p.location_name ?? "Unknown", count: 0 });
          byLoc.get(locId)!.count++;
        }
        const sorted = [...byLoc.entries()].sort((a, b) => b[1].count - a[1].count);
        return (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {sorted.map(([locId, { name, count }]) => (
              <Card
                key={locId}
                className="cursor-pointer hover:border-blue-400 transition-colors"
                onClick={() => { if (locId !== "__unknown") setLocationId(locId); }}
              >
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                    <Building2 size={11} /> {name}
                  </p>
                  <p className="text-2xl font-bold">{count}</p>
                  <p className="text-xs text-muted-foreground">inside</p>
                </CardContent>
              </Card>
            ))}
          </div>
        );
      })()}

      {/* ── Legend ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground items-center pt-2 border-t">
        <span className="flex items-center gap-1"><ShieldCheck size={12} /> Data from COSEC entry reader — exit button has no sensor, so last-exit may lag.</span>
        <span className="flex items-center gap-1"><RefreshCw size={12} /> Auto-refreshes every 30 seconds when Live mode is on.</span>
        <span>Amber rows = inside 8+ hours.</span>
      </div>

    </div>
  );
}

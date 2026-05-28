"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, LogIn, LogOut, Ban, DoorOpen, ShieldCheck,
  ChevronLeft, ChevronRight, Cpu, Wifi, WifiOff, Fingerprint,
  CalendarCheck, AlertCircle,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface CosecDevice {
  id: string;             // UUID used in the application
  label: string;
  device_ip: string;
  device_port: number;
  device_category: "entry_point" | "business_centre" | string;
  supports_biometric: boolean;
  is_enabled: boolean;
  last_ping_at: string | null;
  last_ping_success: boolean | null;
}

interface AccessLog {
  id: string;
  direction: "IN" | "OUT" | "DENIED";
  event_time: string;
  denial_reason: string | null;
  entity_name: string | null;
  device: { id: string; label: string; device_code: string | null } | null;
}

interface BookingWindow {
  booking_number: string;
  guest_name: string | null;
  valid_from: number; // ms epoch, with ±5 min buffer
  valid_until: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function monthRange(year: number, month: number) {
  return {
    from: new Date(year, month, 1).toISOString(),
    to:   new Date(year, month + 1, 1).toISOString(),
  };
}

function monthLabel(year: number, month: number) {
  return new Date(year, month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

function formatPingTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const CATEGORY_LABELS: Record<string, string> = {
  entry_point:       "Entry Point",
  business_centre:   "Business Centre",
};

// ── Device Info Card ─────────────────────────────────────────────────────────

function DeviceInfoCard({ device }: { device: CosecDevice }) {
  const isOnline = device.last_ping_success === true;
  const isUnknown = device.last_ping_at === null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Cpu size={15} className="text-muted-foreground" />
          Access Device
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Device label + online badge */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sm">{device.label}</span>
          <div className="flex items-center gap-1.5">
            {device.is_enabled ? (
              <Badge className="text-xs bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                Enabled
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">Disabled</Badge>
            )}
            {isUnknown ? (
              <Badge variant="outline" className="text-xs text-muted-foreground">No ping</Badge>
            ) : isOnline ? (
              <Badge className="text-xs bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 flex items-center gap-1">
                <Wifi size={10} />
                Online
              </Badge>
            ) : (
              <Badge className="text-xs bg-red-100 text-red-700 border border-red-200 hover:bg-red-100 flex items-center gap-1">
                <WifiOff size={10} />
                Offline
              </Badge>
            )}
          </div>
        </div>

        {/* Detail rows */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <div className="flex justify-between sm:flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">Device UUID</span>
            <span className="font-mono text-xs break-all">{device.id}</span>
          </div>
          <div className="flex justify-between sm:flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">IP Address</span>
            <span className="font-mono text-xs">{device.device_ip}:{device.device_port}</span>
          </div>
          <div className="flex justify-between sm:flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">Category</span>
            <span className="text-xs">{CATEGORY_LABELS[device.device_category] ?? device.device_category}</span>
          </div>
          <div className="flex justify-between sm:flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">Biometric</span>
            <span className="text-xs flex items-center gap-1">
              {device.supports_biometric
                ? <><Fingerprint size={11} className="text-emerald-600" /> Supported</>
                : "Not supported"}
            </span>
          </div>
          {device.last_ping_at && (
            <div className="flex justify-between sm:flex-col gap-0.5">
              <span className="text-muted-foreground text-xs">Last Ping</span>
              <span className="text-xs">{formatPingTime(device.last_ping_at)}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Access Logs ───────────────────────────────────────────────────────────────

function AccessLogsCard({ deviceId, spaceId }: { deviceId: string; spaceId: string }) {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-indexed
  const [logs,           setLogs]           = useState<AccessLog[]>([]);
  const [bookingWindows, setBookingWindows] = useState<BookingWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { from, to } = monthRange(year, month);
      // Date range for booking query (YYYY-MM-DD strings)
      const fromDate = new Date(year, month, 1).toISOString().slice(0, 10);
      const toDate   = new Date(year, month + 1, 0).toISOString().slice(0, 10);

      // Load access logs and space bookings in parallel
      const [{ data: logsData }, { data: bksData }] = await Promise.all([
        supabase
          .from("access_logs")
          .select("id, direction, event_time, denial_reason, entity_name, device:cosec_devices(id, label, device_code)")
          .eq("device_id", deviceId)
          .gte("event_time", from)
          .lt("event_time", to)
          .order("event_time", { ascending: false }),
        supabase
          .from("bookings")
          .select("booking_number, guest_name, booking_date, start_time, end_time")
          .eq("space_id", spaceId)
          .not("status", "in", '("cancelled","no_show")')
          .gte("booking_date", fromDate)
          .lte("booking_date", toDate),
      ]);

      if (!cancelled) {
        setLogs((logsData ?? []) as unknown as AccessLog[]);
        // Build ±5 min windows (same logic as COSEC admin page)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const windows: BookingWindow[] = (bksData ?? []).map((b: any) => ({
          booking_number: b.booking_number,
          guest_name: b.guest_name ?? null,
          valid_from:  new Date(`${b.booking_date}T${b.start_time}+05:30`).getTime() - 5 * 60000,
          valid_until: new Date(`${b.booking_date}T${b.end_time}+05:30`).getTime()   + 5 * 60000,
        }));
        setBookingWindows(windows);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [deviceId, spaceId, year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  function goPrev() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function goNext() {
    if (isCurrentMonth) return;
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }

  const inCount     = logs.filter(l => l.direction === "IN").length;
  const deniedCount = logs.filter(l => l.direction === "DENIED").length;

  // Group by IST calendar date (YYYY-MM-DD), newest date first
  const grouped = useMemo(() => {
    const map = new Map<string, AccessLog[]>();
    for (const log of logs) {
      const date = new Date(log.event_time).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(log);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [logs]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <DoorOpen size={16} />
            Door Access Log
          </CardTitle>

          {/* Month navigator */}
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={goPrev}>
              <ChevronLeft size={14} />
            </Button>
            <span className="text-sm font-medium w-36 text-center tabular-nums">
              {monthLabel(year, month)}
            </span>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={goNext} disabled={isCurrentMonth}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>

        {/* Month summary */}
        {!loading && logs.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {inCount} {inCount === 1 ? "entry" : "entries"}
            {deniedCount > 0 && <> · <span className="text-red-500">{deniedCount} denied</span></>}
            {" "}this month
          </p>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-muted-foreground" size={22} />
          </div>
        ) : logs.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground px-4">
            <DoorOpen size={28} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm font-medium">No access events in {monthLabel(year, month)}</p>
            <p className="text-xs mt-1">Navigate to a previous month to view older records.</p>
          </div>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            {grouped.map(([date, dateLogs]) => {
              // Parse date as local (IST) — avoid UTC offset shifting the date
              const [y, mo, d] = date.split("-").map(Number);
              const dateLabel = new Date(y, mo - 1, d).toLocaleDateString("en-IN", {
                weekday: "short", day: "numeric", month: "short",
              });

              return (
                <div key={date}>
                  {/* Sticky date group header */}
                  <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-1.5 bg-muted/60 backdrop-blur-sm border-y text-xs font-medium text-muted-foreground">
                    <span>{dateLabel}</span>
                    <span className="opacity-60">{dateLogs.length} event{dateLogs.length !== 1 ? "s" : ""}</span>
                  </div>

                  <div className="divide-y">
                    {dateLogs.map(log => {
                      const time = new Date(log.event_time).toLocaleTimeString("en-IN", {
                        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
                      });
                      const ts = new Date(log.event_time).getTime();
                      const matchedBooking = log.direction !== "DENIED"
                        ? (bookingWindows.find(w => ts >= w.valid_from && ts <= w.valid_until) ?? null)
                        : null;
                      const isScheduled   = matchedBooking != null;
                      const isUnscheduled = log.direction !== "DENIED" && !isScheduled;
                      const rowClass =
                        log.direction === "DENIED" ? "bg-red-50/50 border-l-2 border-red-300" :
                        isScheduled               ? "bg-green-50/60 border-l-2 border-green-400" :
                                                    "bg-amber-50/50 border-l-2 border-amber-300";

                      return (
                        <div
                          key={log.id}
                          className={`flex items-center gap-3 px-4 py-2.5 ${rowClass}`}
                        >
                          <div className="shrink-0">
                            {log.direction === "IN"
                              ? <LogIn  size={14} className="text-green-500" />
                              : log.direction === "OUT"
                                ? <LogOut size={14} className="text-blue-500" />
                                : <Ban    size={14} className="text-red-400" />}
                          </div>

                          <div className="flex-1 min-w-0 text-sm">
                            <span className="font-medium">{log.entity_name || "Unknown"}</span>
                            {/* Scheduled / Unscheduled pill */}
                            {isScheduled && matchedBooking && (
                              <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 border border-green-300 text-green-800">
                                <CalendarCheck size={9} />
                                <Link
                                  href={`/bookings/${matchedBooking.booking_number}`}
                                  className="hover:underline font-mono"
                                  onClick={e => e.stopPropagation()}
                                >
                                  {matchedBooking.booking_number}
                                </Link>
                              </span>
                            )}
                            {isUnscheduled && (
                              <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 border border-amber-300 text-amber-800">
                                <AlertCircle size={9} />
                                No booking
                              </span>
                            )}
                            {log.device && (
                              <span className="text-muted-foreground text-xs ml-2">
                                @{log.device.device_code && (
                                  <span className="font-mono ml-1 text-slate-500">{log.device.device_code}</span>
                                )}{" "}
                                <span>{log.device.label}</span>
                              </span>
                            )}
                            {log.denial_reason && (
                              <span className="ml-2 text-xs text-red-500">· {log.denial_reason}</span>
                            )}
                          </div>

                          <div className="text-right shrink-0 space-y-0.5">
                            <div>
                              <Badge
                                variant={log.direction === "DENIED" ? "destructive" : "outline"}
                                className="text-xs"
                              >
                                {log.direction}
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground tabular-nums">{time}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────

export function SpaceAccessTab({ deviceId, spaceId }: { deviceId: string | null; spaceId: string }) {
  const supabase = createClient();
  const [device, setDevice]   = useState<CosecDevice | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from("cosec_devices")
      .select("id, label, device_ip, device_port, device_category, supports_biometric, is_enabled, last_ping_at, last_ping_success")
      .eq("id", deviceId)
      .single()
      .then(({ data }) => {
        if (!cancelled) {
          setDevice((data as CosecDevice) ?? null);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // No device linked
  if (!deviceId) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <ShieldCheck size={32} className="mx-auto mb-3 text-muted-foreground opacity-40" />
          <p className="text-sm font-medium text-muted-foreground">No access device linked</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
            Link a COSEC device to this space from the Edit dialog to track door access.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {loading ? (
        <Card>
          <CardContent className="py-8 flex items-center justify-center">
            <Loader2 className="animate-spin text-muted-foreground" size={22} />
          </CardContent>
        </Card>
      ) : device ? (
        <DeviceInfoCard device={device} />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            Device record not found.
          </CardContent>
        </Card>
      )}

      <AccessLogsCard deviceId={deviceId} spaceId={spaceId} />
    </div>
  );
}

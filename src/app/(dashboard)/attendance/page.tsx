"use client";

/**
 * Biometric Device Test Dashboard — /attendance
 *
 * Test-phase page to:
 *   1. See registered devices and their last heartbeat
 *   2. Watch raw punches arrive in real-time from the device
 *   3. Manually map a device PIN to a CRM entity for testing
 *
 * This page will evolve into the full Attendance module once the
 * device is validated and the full schema is designed.
 */

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Fingerprint, Wifi, WifiOff, RefreshCw, CircleDot,
  Clock, CheckCircle2, LogOut, Coffee, AlertCircle,
  MonitorSmartphone, Pencil, X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelativeDate } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────

interface BiometricDevice {
  id: string;
  serial_number: string;
  alias: string | null;
  firmware_version: string | null;
  push_version: string | null;
  last_seen_at: string | null;
  last_ip: string | null;
  is_active: boolean;
}

interface RawPunch {
  id: string;
  device_serial: string;
  device_pin: string;
  punch_time: string;
  status_code: number | null;
  verify_type: number | null;
  entity_type: string | null;
  entity_name: string | null;
  raw_line: string | null;
  created_at: string;
}

interface UserMap {
  id: string;
  device_serial: string;
  device_pin: string;
  entity_type: string;
  entity_id: string;
  display_name: string;
  is_active: boolean;
}

// ── Label helpers ─────────────────────────────────────────────

const STATUS_LABELS: Record<number, { label: string; icon: React.ReactNode; color: string }> = {
  0: { label: "Check-in",   icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: "text-green-600"  },
  1: { label: "Check-out",  icon: <LogOut        className="h-3.5 w-3.5" />, color: "text-orange-600" },
  4: { label: "Break-out",  icon: <Coffee        className="h-3.5 w-3.5" />, color: "text-yellow-600" },
  5: { label: "Break-in",   icon: <Coffee        className="h-3.5 w-3.5" />, color: "text-blue-600"   },
};

const VERIFY_LABELS: Record<number, string> = {
  0: "PIN",
  1: "Fingerprint",
  4: "RFID Card",
  15: "Face",
};

function statusInfo(code: number | null) {
  if (code === null) return { label: "Unknown", icon: <CircleDot className="h-3.5 w-3.5" />, color: "text-muted-foreground" };
  return STATUS_LABELS[code] ?? { label: `Code ${code}`, icon: <CircleDot className="h-3.5 w-3.5" />, color: "text-muted-foreground" };
}

function isOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 5 * 60 * 1000; // 5 min
}

// ── Component ─────────────────────────────────────────────────

export default function AttendanceTestPage() {
  const supabase = createClient();

  const [devices,    setDevices]    = useState<BiometricDevice[]>([]);
  const [punches,    setPunches]    = useState<RawPunch[]>([]);
  const [userMaps,   setUserMaps]   = useState<UserMap[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [liveCount,  setLiveCount]  = useState(0);

  // map form state
  const [mapForm, setMapForm] = useState<{
    device_serial: string; device_pin: string;
    entity_type: string; entity_id: string; display_name: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Load initial data ──────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: devs }, { data: pts }, { data: maps }] = await Promise.all([
      supabase.from("biometric_devices").select("*").order("last_seen_at", { ascending: false }),
      supabase.from("biometric_raw_punches").select("*").order("punch_time", { ascending: false }).limit(50),
      supabase.from("biometric_user_map").select("*").order("enrolled_at", { ascending: false }),
    ]);
    setDevices(devs ?? []);
    setPunches(pts   ?? []);
    setUserMaps(maps ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  // ── Real-time subscription ─────────────────────────────────

  useEffect(() => {
    const channel = supabase
      .channel("biometric-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "biometric_raw_punches" },
        (payload) => {
          setPunches((prev) => [payload.new as RawPunch, ...prev].slice(0, 50));
          setLiveCount((c) => c + 1);
        }
      )
      .on("postgres_changes", { event: "INSERT",  schema: "public", table: "biometric_devices" }, () => load())
      .on("postgres_changes", { event: "UPDATE",  schema: "public", table: "biometric_devices" }, () => load())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [supabase, load]);

  // ── Save user map ──────────────────────────────────────────

  async function saveMap() {
    if (!mapForm) return;
    setSaving(true);
    await supabase.from("biometric_user_map").upsert(
      { ...mapForm, is_active: true, enrolled_at: new Date().toISOString() },
      { onConflict: "device_serial,device_pin" }
    );
    setSaving(false);
    setMapForm(null);
    load();
  }

  // ── Render ─────────────────────────────────────────────────

  const serverUrl = typeof window !== "undefined"
    ? `${window.location.origin}`
    : "https://twv-crm.vercel.app";

  return (
    <div className="p-6 space-y-6 max-w-6xl">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Fingerprint className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Biometric Device — Test Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Validate eSSL F22 connectivity before full module build
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {liveCount > 0 && (
            <Badge variant="outline" className="gap-1 text-green-700 border-green-300 bg-green-50">
              <CircleDot className="h-3 w-3 animate-pulse" />
              {liveCount} live punch{liveCount !== 1 ? "es" : ""}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Device Setup Instructions */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <MonitorSmartphone className="h-4 w-4 text-blue-600" />
            Device Setup — Configure on eSSL F22
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-1 text-blue-900">
          <p>On the device: <strong>Menu → Comm → ADMS Settings</strong></p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-0.5 mt-2 font-mono bg-white/70 rounded p-2 border border-blue-200">
            <span className="text-muted-foreground">Server Address</span>
            <span className="font-semibold">{serverUrl.replace("https://", "").replace("http://", "")}</span>
            <span className="text-muted-foreground">Server Port</span>
            <span className="font-semibold">443</span>
            <span className="text-muted-foreground">HTTPS</span>
            <span className="font-semibold">Enable</span>
            <span className="text-muted-foreground">Push Endpoint</span>
            <span className="font-semibold">/iclock/cdata</span>
          </div>
          <p className="pt-1 text-blue-700">
            Once saved and the device restarts, it will appear below within ~30 seconds.
          </p>
        </CardContent>
      </Card>

      {/* Connected Devices */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Registered Devices</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : devices.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <WifiOff className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No devices connected yet.</p>
              <p className="text-xs mt-1">Configure the device with the settings above.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {devices.map((dev) => (
                <div key={dev.id} className="flex items-center justify-between p-3 rounded-lg border bg-card">
                  <div className="flex items-center gap-3">
                    <div className={`h-2.5 w-2.5 rounded-full ${isOnline(dev.last_seen_at) ? "bg-green-500" : "bg-muted"}`} />
                    <div>
                      <p className="text-sm font-medium">
                        {dev.alias ?? dev.serial_number}
                        {dev.alias && <span className="text-muted-foreground text-xs ml-2 font-normal">{dev.serial_number}</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isOnline(dev.last_seen_at) ? "Online" : "Offline"} ·
                        Last seen {dev.last_seen_at ? formatRelativeDate(dev.last_seen_at) : "never"} ·
                        IP {dev.last_ip ?? "—"}
                        {dev.firmware_version && ` · FW ${dev.firmware_version}`}
                      </p>
                    </div>
                  </div>
                  <Badge variant={isOnline(dev.last_seen_at) ? "default" : "secondary"} className="text-xs">
                    {isOnline(dev.last_seen_at)
                      ? <><Wifi className="h-3 w-3 mr-1" />Online</>
                      : <><WifiOff className="h-3 w-3 mr-1" />Offline</>}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Raw Punch Log */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Live Punch Log (last 50)</CardTitle>
          <Button
            size="sm" variant="outline"
            onClick={() => setMapForm({ device_serial: devices[0]?.serial_number ?? "", device_pin: "", entity_type: "employee", entity_id: "", display_name: "" })}
          >
            <Pencil className="h-3.5 w-3.5 mr-1.5" />
            Map a PIN
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : punches.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Clock className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No punches received yet.</p>
              <p className="text-xs mt-1">Try scanning a fingerprint on the device.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 pr-4 font-medium">Time</th>
                    <th className="text-left py-2 pr-4 font-medium">Device</th>
                    <th className="text-left py-2 pr-4 font-medium">PIN</th>
                    <th className="text-left py-2 pr-4 font-medium">Status</th>
                    <th className="text-left py-2 pr-4 font-medium">Method</th>
                    <th className="text-left py-2 font-medium">Matched To</th>
                  </tr>
                </thead>
                <tbody>
                  {punches.map((p) => {
                    const s = statusInfo(p.status_code);
                    return (
                      <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2 pr-4 tabular-nums text-muted-foreground whitespace-nowrap">
                          {new Date(p.punch_time).toLocaleString("en-IN", {
                            day: "2-digit", month: "short",
                            hour: "2-digit", minute: "2-digit", second: "2-digit",
                          })}
                        </td>
                        <td className="py-2 pr-4 font-mono text-muted-foreground">{p.device_serial.slice(-6)}</td>
                        <td className="py-2 pr-4 font-mono font-semibold">{p.device_pin}</td>
                        <td className={`py-2 pr-4 ${s.color}`}>
                          <span className="flex items-center gap-1">
                            {s.icon} {s.label}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {VERIFY_LABELS[p.verify_type ?? 0] ?? `Type ${p.verify_type}`}
                        </td>
                        <td className="py-2">
                          {p.entity_name ? (
                            <span className="flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3 text-green-600" />
                              <span className="font-medium">{p.entity_name}</span>
                              <span className="text-muted-foreground">({p.entity_type})</span>
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-amber-600">
                              <AlertCircle className="h-3 w-3" />
                              Not mapped
                            </span>
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

      {/* PIN → Entity Map */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">PIN Mappings</CardTitle>
        </CardHeader>
        <CardContent>
          {userMaps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No mappings yet. When an unmapped PIN punches, click &quot;Map a PIN&quot; above to link it to an employee or member.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-2 pr-4 font-medium">Device</th>
                  <th className="text-left py-2 pr-4 font-medium">PIN</th>
                  <th className="text-left py-2 pr-4 font-medium">Name</th>
                  <th className="text-left py-2 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {userMaps.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-muted-foreground">{m.device_serial.slice(-6)}</td>
                    <td className="py-2 pr-4 font-mono font-semibold">{m.device_pin}</td>
                    <td className="py-2 pr-4 font-medium">{m.display_name}</td>
                    <td className="py-2">
                      <Badge variant="secondary" className="text-[10px]">{m.entity_type}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Add mapping modal */}
      {mapForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Map Device PIN to Person</h2>
              <button onClick={() => setMapForm(null)}><X className="h-4 w-4" /></button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter the PIN number assigned to this person when their fingerprint was enrolled on the device.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium">Device Serial</label>
                <Input value={mapForm.device_serial} onChange={e => setMapForm(f => f ? { ...f, device_serial: e.target.value } : f)} className="mt-1 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium">Device PIN (number on device)</label>
                <Input value={mapForm.device_pin} onChange={e => setMapForm(f => f ? { ...f, device_pin: e.target.value } : f)} placeholder="e.g. 1" className="mt-1 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium">Person Type</label>
                <select
                  className="mt-1 w-full border rounded-md px-3 py-2 text-sm"
                  value={mapForm.entity_type}
                  onChange={e => setMapForm(f => f ? { ...f, entity_type: e.target.value } : f)}
                >
                  <option value="employee">Employee</option>
                  <option value="member">Contract Member</option>
                  <option value="booking">Booking Customer</option>
                  <option value="guest">Guest</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium">Display Name</label>
                <Input value={mapForm.display_name} onChange={e => setMapForm(f => f ? { ...f, display_name: e.target.value } : f)} placeholder="e.g. Vinit Chordia" className="mt-1 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium">CRM Entity ID (optional for test)</label>
                <Input value={mapForm.entity_id} onChange={e => setMapForm(f => f ? { ...f, entity_id: e.target.value } : f)} placeholder="UUID from leads/bookings table" className="mt-1 text-sm" />
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" size="sm" onClick={() => setMapForm(null)}>Cancel</Button>
              <Button size="sm" onClick={saveMap} disabled={saving || !mapForm.device_pin || !mapForm.display_name}>
                {saving ? "Saving…" : "Save Mapping"}
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

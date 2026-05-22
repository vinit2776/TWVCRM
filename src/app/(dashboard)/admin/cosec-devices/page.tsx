"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Wifi, WifiOff, Plus, Pencil, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface Location {
  id: string;
  name: string;
}

interface CosecDevice {
  id: string;
  location_id: string;
  label: string;
  device_ip: string;
  device_port: number;
  is_enabled: boolean;
  device_category: "entry_point" | "business_centre";
  last_ping_at: string | null;
  last_ping_success: boolean | null;
  last_polled_at: string | null;
  last_seq_number: number;
  location: { name: string };
}

interface PingResult {
  ok: boolean;
  deviceName?: string;
  appVersion?: string;
  error?: string;
  latencyMs?: number;
}

const EMPTY_FORM = {
  location_id: "",
  label: "Main Entrance",
  device_ip: "",
  device_port: 80,
  device_password: "",
  device_category: "entry_point" as "entry_point" | "business_centre",
};

export default function CosecDevicesPage() {
  const supabase = createClient();
  const router = useRouter();
  const [devices, setDevices] = useState<CosecDevice[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CosecDevice | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [pinging, setPinging] = useState<Record<string, boolean>>({});
  const [pingResults, setPingResults] = useState<Record<string, PingResult>>({});
  const [liveTestResult, setLiveTestResult] = useState<PingResult | null>(null);
  const [liveTestPinging, setLiveTestPinging] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: devs }, { data: locs }] = await Promise.all([
      supabase
        .from("cosec_devices")
        .select("*, location:locations(name)")
        .order("created_at"),
      supabase.from("locations").select("id, name").order("name"),
    ]);
    setDevices((devs as CosecDevice[]) || []);
    setLocations(locs || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setLiveTestResult(null);
    setDialogOpen(true);
  }

  function openEdit(device: CosecDevice) {
    setEditing(device);
    setForm({
      location_id: device.location_id,
      label: device.label,
      device_ip: device.device_ip,
      device_port: device.device_port,
      device_password: "", // never prefill password
      device_category: device.device_category ?? "entry_point",
    });
    setLiveTestResult(null);
    setDialogOpen(true);
  }

  async function handleLiveTest() {
    if (!form.device_ip || !form.device_password) {
      toast.error("Enter IP and password before testing");
      return;
    }
    setLiveTestPinging(true);
    setLiveTestResult(null);
    try {
      const res = await fetch("/api/cosec/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_ip: form.device_ip,
          device_port: form.device_port,
          device_password: form.device_password,
        }),
      });
      const result: PingResult = await res.json();
      setLiveTestResult(result);
      if (result.ok) {
        toast.success(`Connected — ${result.deviceName} (${result.latencyMs}ms)`);
      } else {
        toast.error(`Connection failed: ${result.error}`);
      }
    } catch {
      setLiveTestResult({ ok: false, error: "Network error" });
    } finally {
      setLiveTestPinging(false);
    }
  }

  async function handleSave() {
    if (!form.location_id || !form.device_ip || (!editing && !form.device_password)) {
      toast.error("Location, IP, and password are required");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const payload: Record<string, unknown> = {
          location_id: form.location_id,
          label: form.label,
          device_ip: form.device_ip,
          device_port: form.device_port,
          device_category: form.device_category,
          updated_at: new Date().toISOString(),
        };
        if (form.device_password) payload.device_password = form.device_password;
        const { error } = await supabase
          .from("cosec_devices")
          .update(payload)
          .eq("id", editing.id);
        if (error) throw error;
        toast.success("Device updated");
      } else {
        const { error } = await supabase.from("cosec_devices").insert({
          location_id: form.location_id,
          label: form.label,
          device_ip: form.device_ip,
          device_port: form.device_port,
          device_password: form.device_password,
          device_category: form.device_category,
        });
        if (error) throw error;
        toast.success("Device added");
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function pingExisting(deviceId: string) {
    setPinging(p => ({ ...p, [deviceId]: true }));
    try {
      const res = await fetch("/api/cosec/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId }),
      });
      const result: PingResult = await res.json();
      setPingResults(r => ({ ...r, [deviceId]: result }));
      if (result.ok) {
        toast.success(`${result.deviceName} — ${result.latencyMs}ms`);
      } else {
        toast.error(`Unreachable: ${result.error}`);
      }
      await load();
    } finally {
      setPinging(p => ({ ...p, [deviceId]: false }));
    }
  }

  async function toggleEnabled(device: CosecDevice) {
    await supabase
      .from("cosec_devices")
      .update({ is_enabled: !device.is_enabled })
      .eq("id", device.id);
    await load();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-muted-foreground" size={28} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">COSEC Biometric Devices</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage Matrix COSEC door controllers per facility location.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus size={16} className="mr-2" />
          Add Device
        </Button>
      </div>

      {devices.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <ShieldCheck size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No devices configured</p>
            <p className="text-sm mt-1">Add a device to start managing biometric access.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {devices.map((device) => {
            const result = pingResults[device.id];
            const isPinging = pinging[device.id];
            const lastSuccess = result ? result.ok : device.last_ping_success;

            return (
              <Card key={device.id} className={`${!device.is_enabled ? "opacity-60" : ""} cursor-pointer hover:shadow-md transition-shadow`} onClick={() => router.push(`/admin/cosec-devices/${device.id}`)}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        {lastSuccess === true ? (
                          <Wifi size={16} className="text-green-500" />
                        ) : lastSuccess === false ? (
                          <WifiOff size={16} className="text-red-500" />
                        ) : (
                          <Wifi size={16} className="text-muted-foreground opacity-40" />
                        )}
                        {device.label}
                        <Badge variant={device.is_enabled ? "default" : "secondary"} className="text-xs">
                          {device.is_enabled ? "Enabled" : "Disabled"}
                        </Badge>
                        {device.device_category === "business_centre" ? (
                          <Badge variant="outline" className="text-xs border-amber-400 text-amber-700 bg-amber-50">
                            Business Centre
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs border-blue-400 text-blue-700 bg-blue-50">
                            Entry Point
                          </Badge>
                        )}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {device.location?.name} · {device.device_ip}:{device.device_port}
                      </CardDescription>
                    </div>
                    <div className="flex gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => pingExisting(device.id)}
                        disabled={isPinging}
                      >
                        {isPinging ? (
                          <Loader2 size={14} className="animate-spin mr-1" />
                        ) : (
                          <Wifi size={14} className="mr-1" />
                        )}
                        Test Connection
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(device)}>
                        <Pencil size={14} />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    {result && (
                      <span className={result.ok ? "text-green-600 font-medium" : "text-red-500 font-medium"}>
                        {result.ok
                          ? `✓ ${result.deviceName} · ${result.latencyMs}ms`
                          : `✗ ${result.error}`}
                      </span>
                    )}
                    {device.last_ping_at && !result && (
                      <span>Last ping: {formatDate(device.last_ping_at)}</span>
                    )}
                    {device.last_polled_at && (
                      <span>Last event poll: {formatDate(device.last_polled_at)}</span>
                    )}
                    <span>Events synced up to seq #{device.last_seq_number}</span>
                  </div>
                  <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs"
                      onClick={() => toggleEnabled(device)}
                    >
                      {device.is_enabled ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Device" : "Add COSEC Device"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={form.location_id} onValueChange={v => setForm(f => ({ ...f, location_id: v }))}>
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
              <Label>Device Label</Label>
              <Input
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="Main Entrance"
              />
            </div>

            <div className="space-y-2">
              <Label>Device Category</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, device_category: "entry_point" }))}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    form.device_category === "entry_point"
                      ? "border-blue-500 bg-blue-50 ring-1 ring-blue-400"
                      : "border-border hover:border-blue-300 hover:bg-blue-50/40"
                  }`}
                >
                  <p className="text-sm font-medium text-blue-800">Entry Point</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Front/back door. Members get permanent biometric + card enrollment.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, device_category: "business_centre" }))}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    form.device_category === "business_centre"
                      ? "border-amber-500 bg-amber-50 ring-1 ring-amber-400"
                      : "border-border hover:border-amber-300 hover:bg-amber-50/40"
                  }`}
                >
                  <p className="text-sm font-medium text-amber-800">Business Centre</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Conference/meeting room. Temporary PIN access per booking only.
                  </p>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-2">
                <Label>Public Static IP Address</Label>
                <Input
                  value={form.device_ip}
                  onChange={e => setForm(f => ({ ...f, device_ip: e.target.value }))}
                  placeholder="e.g. 103.x.x.x"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Use the port-forwarded public IP — not the local LAN IP. The server connects remotely.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Port</Label>
                <Input
                  type="number"
                  value={form.device_port}
                  onChange={e => setForm(f => ({ ...f, device_port: parseInt(e.target.value) || 80 }))}
                  placeholder="80"
                  className="font-mono"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Device Admin Password</Label>
              <Input
                type="password"
                value={form.device_password}
                onChange={e => setForm(f => ({ ...f, device_password: e.target.value }))}
                placeholder={editing ? "Leave blank to keep existing" : "Device password"}
              />
            </div>

            {/* Live connection test before saving */}
            <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
              <p className="text-xs text-muted-foreground font-medium">Test before saving</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full"
                onClick={handleLiveTest}
                disabled={liveTestPinging}
              >
                {liveTestPinging ? (
                  <><Loader2 size={14} className="animate-spin mr-2" /> Connecting…</>
                ) : (
                  <><Wifi size={14} className="mr-2" /> Test Connection Now</>
                )}
              </Button>
              {liveTestResult && (
                <div className={`text-xs flex items-center gap-2 font-medium ${liveTestResult.ok ? "text-green-600" : "text-red-500"}`}>
                  {liveTestResult.ok ? (
                    <><ShieldCheck size={14} /> Connected · {liveTestResult.deviceName} · {liveTestResult.latencyMs}ms · App v{liveTestResult.appVersion}</>
                  ) : (
                    <><AlertTriangle size={14} /> {liveTestResult.error}</>
                  )}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin mr-2" />}
              {editing ? "Save Changes" : "Add Device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCurrentUser } from "@/providers/current-user-provider";
import { checkConnectionInput, cleanAliases, consumerKey, MAX_ALIASES } from "@/lib/electricity-connections";
import type { ElectricityConnection } from "@/types";

interface Props {
  locationId: string;
  /** The location's existing single "service number" setting, offered for one-click import. */
  serviceNumber: string | null;
  /** The location's configured electricity vendor, used for that import. */
  configVendorId: string | null;
  /** True when this location has OneGrid telemetry switched on with a key — meters can then be picked from a list. */
  onegridEnabled: boolean;
}

interface VendorOption { id: string; name: string }
interface DeviceOption { device_id: string; label: string }

const NOT_TRACKED = "__none__";

const emptyForm = {
  vendor_id: "",
  consumer_number: "",
  bill_aliases: [] as string[],
  meter_label: "",
  onegrid_device_id: "",
  sanctioned_kva: "",
};

export function ElectricityConnectionsCard({ locationId, serviceNumber, configVendorId, onegridEnabled }: Props) {
  const { user } = useCurrentUser();
  const isAdmin = user?.role === "admin";

  const [connections, setConnections] = useState<ElectricityConnection[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [devices, setDevices] = useState<DeviceOption[] | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ElectricityConnection | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [aliasDraft, setAliasDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/locations/${locationId}/electricity-connections?include_inactive=true`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load connections");
      setConnections(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connections");
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/procurement/vendors?is_electricity_provider=true")
      .then((r) => r.json())
      .then((j) => setVendors((j.data ?? []).map((v: { id: string; name: string }) => ({ id: v.id, name: v.name }))))
      .catch(() => setVendors([]));
  }, []);

  // OneGrid meters are only listed when the dialog is opened, and only if telemetry is on; a failure
  // just falls back to typing the meter id, so a OneGrid outage never blocks editing a connection.
  const loadDevices = useCallback(async () => {
    if (!onegridEnabled || devices !== null) return;
    try {
      const res = await fetch(`/api/locations/${locationId}/telemetry/devices`);
      const json = await res.json();
      if (!res.ok) throw new Error();
      const options: DeviceOption[] = Object.values(json.data.by_plant as Record<string, { plant_name: string; devices: { device_id: string; device_label: string; meter_role: string }[] }>)
        .flatMap((p) => p.devices.map((d) => ({ device_id: d.device_id, label: `${d.device_label} (${d.meter_role}) — ${p.plant_name}` })));
      setDevices(options);
    } catch {
      setDevices([]);
    }
  }, [locationId, onegridEnabled, devices]);

  const active = useMemo(() => (connections ?? []).filter((c) => c.is_active), [connections]);
  const visible = showInactive ? connections ?? [] : active;
  const inactiveCount = (connections?.length ?? 0) - active.length;
  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? connections?.find((c) => c.vendor_id === id)?.vendor?.name ?? "Vendor";

  const importable =
    isAdmin && serviceNumber && configVendorId && consumerKey(serviceNumber) &&
    !(connections ?? []).some((c) => c.is_active && c.vendor_id === configVendorId && consumerKey(c.consumer_number) === consumerKey(serviceNumber));
  const importBlockedByVendor = importable && !vendors.some((v) => v.id === configVendorId);

  function openNew() {
    setEditing(null);
    setForm({ ...emptyForm, vendor_id: vendors.length === 1 ? vendors[0].id : "" });
    setAliasDraft("");
    setFormError(null);
    setDialogOpen(true);
    loadDevices();
  }

  function openEdit(c: ElectricityConnection) {
    setEditing(c);
    setForm({
      vendor_id: c.vendor_id,
      consumer_number: c.consumer_number ?? "",
      bill_aliases: c.bill_aliases,
      meter_label: c.meter_label ?? "",
      onegrid_device_id: c.onegrid_device_id ?? "",
      sanctioned_kva: c.sanctioned_kva != null ? String(c.sanctioned_kva) : "",
    });
    setAliasDraft("");
    setFormError(null);
    setDialogOpen(true);
    loadDevices();
  }

  function addAlias() {
    const next = cleanAliases([...form.bill_aliases, aliasDraft]);
    if (next.length !== form.bill_aliases.length) setForm((f) => ({ ...f, bill_aliases: next }));
    setAliasDraft("");
  }

  const kva = form.sanctioned_kva.trim() === "" ? null : Number(form.sanctioned_kva);
  const check = checkConnectionInput({
    consumer_number: form.consumer_number,
    bill_aliases: form.bill_aliases,
    sanctioned_kva: kva != null && Number.isFinite(kva) ? kva : kva == null ? null : 0,
  });

  async function save() {
    // A name typed but not yet confirmed with Enter is still intended.
    const aliases = cleanAliases([...form.bill_aliases, aliasDraft]);
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        consumer_number: form.consumer_number.trim() || null,
        bill_aliases: aliases,
        meter_label: form.meter_label.trim() || null,
        onegrid_device_id: form.onegrid_device_id.trim() || null,
        sanctioned_kva: kva,
        ...(editing ? {} : { vendor_id: form.vendor_id }),
      };
      const res = await fetch(
        editing ? `/api/locations/${locationId}/electricity-connections/${editing.id}` : `/api/locations/${locationId}/electricity-connections`,
        { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(typeof json?.error === "string" ? json.error : "Could not save the connection");
        return;
      }
      toast.success(editing ? "Connection updated" : "Connection added");
      setDialogOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function setActive(c: ElectricityConnection, isActive: boolean) {
    const res = await fetch(`/api/locations/${locationId}/electricity-connections/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: isActive }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) { toast.error(typeof json?.error === "string" ? json.error : "Could not update the connection"); return; }
    toast.success(isActive ? "Connection reactivated" : "Connection deactivated");
    load();
  }

  async function importServiceNumber() {
    if (!configVendorId || !serviceNumber) return;
    setImporting(true);
    try {
      const res = await fetch(`/api/locations/${locationId}/electricity-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_id: configVendorId, consumer_number: serviceNumber }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) { toast.error(typeof json?.error === "string" ? json.error : "Could not import the service number"); return; }
      toast.success("Service number imported as a connection");
      load();
    } finally {
      setImporting(false);
    }
  }

  const deviceLabel = (id: string | null) => (id ? devices?.find((d) => d.device_id === id)?.label ?? id : null);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Connections</CardTitle>
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={openNew} disabled={vendors.length === 0}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add connection
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          One row per utility connection at this location. Bills are recognised by the consumer number or a remembered name — never by how the bill words the site.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isAdmin && vendors.length === 0 && connections && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            No vendor is marked as an electricity provider yet. Switch it on for the utility or landlord under Procurement → Vendors, then add connections here.
          </p>
        )}

        {importable && (
          <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-900">
            This location already has a service number (<b className="font-medium">{serviceNumber}</b>) in its settings.
            {importBlockedByVendor ? (
              <span> To import it, first mark its electricity vendor as an electricity provider under Procurement → Vendors.</span>
            ) : (
              <>
                {" "}
                <Button size="sm" variant="outline" className="ml-1 h-7" onClick={importServiceNumber} disabled={importing}>
                  {importing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />} Import as a connection
                </Button>
                <span className="mt-1 block text-[11px] text-blue-800">Nothing is copied automatically. This creates one connection from that number and the vendor above; the old field is left as it is.</span>
              </>
            )}
          </div>
        )}

        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive"><AlertTriangle className="h-4 w-4" /> {error}</p>
        ) : connections === null ? (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connections yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-2 font-normal">Vendor</th>
                  <th className="py-1.5 pr-2 font-normal">Consumer number</th>
                  <th className="py-1.5 pr-2 font-normal">Remembered names</th>
                  <th className="py-1.5 pr-2 font-normal">Meter on the bill</th>
                  <th className="py-1.5 pr-2 font-normal">OneGrid meter</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Sanctioned</th>
                  {isAdmin && <th className="py-1.5" />}
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id} className={`border-b align-top last:border-0 ${c.is_active ? "" : "opacity-55"}`}>
                    <td className="py-2 pr-2">{c.vendor?.name ?? vendorName(c.vendor_id)}{!c.is_active && <Badge variant="outline" className="ml-1.5 text-[10px]">Inactive</Badge>}</td>
                    <td className="py-2 pr-2">{c.consumer_number ? <b className="font-medium">{c.consumer_number}</b> : <span className="text-muted-foreground">none</span>}</td>
                    <td className="py-2 pr-2">
                      {c.bill_aliases.length === 0 ? <span className="text-muted-foreground">—</span> : (
                        <div className="flex flex-wrap gap-1">{c.bill_aliases.map((a) => <span key={a} className="rounded-full bg-muted px-2 py-0.5">“{a}”</span>)}</div>
                      )}
                    </td>
                    <td className="py-2 pr-2">{c.meter_label ?? "—"}</td>
                    <td className="py-2 pr-2">{c.onegrid_device_id ? deviceLabel(c.onegrid_device_id) : <span className="text-muted-foreground">Not tracked</span>}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{c.sanctioned_kva != null ? `${c.sanctioned_kva} kVA` : "—"}</td>
                    {isAdmin && (
                      <td className="whitespace-nowrap py-2 text-right">
                        {c.is_active ? (
                          <>
                            <Button size="sm" variant="ghost" className="h-7" onClick={() => openEdit(c)}>Edit</Button>
                            <Button size="sm" variant="ghost" className="h-7" onClick={() => setActive(c, false)}>Deactivate</Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => setActive(c, true)}>Reactivate</Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {inactiveCount > 0 && (
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? "Hide" : "Show"} {inactiveCount} deactivated
          </button>
        )}
        {!isAdmin && <p className="text-[11px] text-muted-foreground">Only an admin can change connections.</p>}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{editing ? "Edit connection" : "Add connection"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Vendor <span className="text-red-500">*</span></Label>
              <Select value={form.vendor_id} onValueChange={(v) => setForm((f) => ({ ...f, vendor_id: v }))} disabled={!!editing}>
                <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
                <SelectContent>{vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Consumer number</Label>
              <Input value={form.consumer_number} onChange={(e) => setForm((f) => ({ ...f, consumer_number: e.target.value }))} placeholder="as printed on the bill (optional)" />
            </div>
            <div className="space-y-1">
              <Label>Meter on the bill</Label>
              <Input value={form.meter_label} onChange={(e) => setForm((f) => ({ ...f, meter_label: e.target.value }))} placeholder="e.g. Main HT meter" />
            </div>
            <div className="space-y-1">
              <Label>OneGrid meter</Label>
              {onegridEnabled && devices && devices.length > 0 ? (
                <Select value={form.onegrid_device_id || NOT_TRACKED} onValueChange={(v) => setForm((f) => ({ ...f, onegrid_device_id: v === NOT_TRACKED ? "" : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NOT_TRACKED}>Not tracked</SelectItem>
                    {devices.map((d) => <SelectItem key={d.device_id} value={d.device_id}>{d.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input value={form.onegrid_device_id} onChange={(e) => setForm((f) => ({ ...f, onegrid_device_id: e.target.value }))} placeholder={onegridEnabled ? "OneGrid meter id (list unavailable)" : "OneGrid meter id (optional)"} />
              )}
            </div>
            <div className="space-y-1">
              <Label>Sanctioned demand (kVA)</Label>
              <Input inputMode="decimal" value={form.sanctioned_kva} onChange={(e) => setForm((f) => ({ ...f, sanctioned_kva: e.target.value }))} placeholder="optional" />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Remembered names <span className="text-xs font-normal text-muted-foreground">— wordings this vendor prints for the site (press Enter after each)</span></Label>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border p-1.5">
              {form.bill_aliases.map((a) => (
                <span key={a} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                  “{a}”
                  <button type="button" aria-label={`Remove ${a}`} onClick={() => setForm((f) => ({ ...f, bill_aliases: f.bill_aliases.filter((x) => x !== a) }))}><X className="h-3 w-3 opacity-60" /></button>
                </span>
              ))}
              <input
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAlias(); } }}
                disabled={form.bill_aliases.length >= MAX_ALIASES}
                placeholder="add a name as printed…"
                className="min-w-[10rem] flex-1 bg-transparent px-1 text-xs outline-none"
              />
            </div>
          </div>

          {(formError || check.errors.length > 0) && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{formError ?? check.errors.join(" ")}</p>
          )}
          {!formError && check.errors.length === 0 && check.warnings.length > 0 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{check.warnings[0]}</p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !form.vendor_id || check.errors.length > 0}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Save connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

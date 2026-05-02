"use client";

/**
 * Add / edit a facility asset (UDM, switch, AP, etc.) at a location.
 * Compact single-screen dialog — no wizard needed because the data is short.
 */

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { FacilityAsset, FacilityAssetCategory } from "@/types";

interface Location { id: string; name: string }
interface Floor { id: string; name: string; floor_number?: number | null }

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  asset?: FacilityAsset | null;
  defaultLocationId?: string;
  onSuccess: (asset: FacilityAsset) => void;
}

export function FacilityAssetFormDialog({ open, onOpenChange, asset, defaultLocationId, onSuccess }: Props) {
  const isEdit = !!asset;

  const [locations, setLocations] = useState<Location[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [categories, setCategories] = useState<FacilityAssetCategory[]>([]);

  const [form, setForm] = useState({
    location_id: "", floor_id: "", category_id: "",
    name: "", asset_code: "",
    make: "", model: "", serial_number: "", mac_address: "", ip_address: "",
    purchase_date: "", warranty_expiry: "", vendor: "",
    status: "active" as "active" | "maintenance" | "retired",
    location_notes: "", notes: "",
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      fetch("/api/locations?is_active=true").then((r) => r.json()),
      fetch("/api/facility/categories?scope=it").then((r) => r.json()),
    ]).then(([loc, cat]) => {
      setLocations(loc.data || []);
      setCategories(cat.data || []);
    });
    setForm({
      location_id: asset?.location_id || defaultLocationId || "",
      floor_id: asset?.floor_id || "",
      category_id: asset?.category_id || "",
      name: asset?.name || "",
      asset_code: asset?.asset_code || "",
      make: asset?.make || "",
      model: asset?.model || "",
      serial_number: asset?.serial_number || "",
      mac_address: asset?.mac_address || "",
      ip_address: asset?.ip_address || "",
      purchase_date: asset?.purchase_date?.slice(0, 10) || "",
      warranty_expiry: asset?.warranty_expiry?.slice(0, 10) || "",
      vendor: asset?.vendor || "",
      status: (asset?.status || "active") as "active" | "maintenance" | "retired",
      location_notes: asset?.location_notes || "",
      notes: asset?.notes || "",
    });
  }, [open, asset, defaultLocationId]);

  useEffect(() => {
    if (!form.location_id) { setFloors([]); return; }
    fetch(`/api/locations/${form.location_id}/floors`)
      .then((r) => r.json())
      .then((j) => setFloors(j.data || []));
  }, [form.location_id]);

  // Auto-suggest asset code when category + location chosen
  useEffect(() => {
    if (isEdit || form.asset_code) return;
    if (!form.category_id || !form.location_id) return;
    const cat = categories.find((c) => c.id === form.category_id);
    const loc = locations.find((l) => l.id === form.location_id);
    if (!cat || !loc) return;
    const locPrefix = (loc.name.match(/[A-Z]/g)?.slice(0, 3).join("") || "LOC").toUpperCase();
    const catPrefix = (cat.slug.split("-").pop() || cat.name.slice(0, 3)).toUpperCase().slice(0, 4);
    setForm((f) => ({ ...f, asset_code: `${locPrefix}-${catPrefix}-001` }));
  }, [form.location_id, form.category_id, isEdit, categories, locations, form.asset_code]);

  const submit = async () => {
    if (!form.location_id || !form.category_id || !form.name.trim() || !form.asset_code.trim()) {
      toast.error("Location, category, name and asset code are required");
      return;
    }
    setBusy(true);
    try {
      const url = isEdit ? `/api/facility/assets/${asset!.id}` : "/api/facility/assets";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          purchase_date: form.purchase_date || null,
          warranty_expiry: form.warranty_expiry || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast.success(isEdit ? "Asset updated" : "Asset added");
      onSuccess(json.data);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit asset" : "Add asset"}</DialogTitle>
          <DialogDescription>Track this device so issues can be linked to it for analytics.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[65vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Location *</Label>
              <select
                value={form.location_id}
                onChange={(e) => setForm({ ...form, location_id: e.target.value, floor_id: "" })}
                className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
                disabled={isEdit}
              >
                <option value="">— Select —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs">Floor</Label>
              <select
                value={form.floor_id}
                onChange={(e) => setForm({ ...form, floor_id: e.target.value })}
                className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
              >
                <option value="">— Any —</option>
                {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <Label className="text-xs">Category *</Label>
            <select
              value={form.category_id}
              onChange={(e) => setForm({ ...form, category_id: e.target.value })}
              className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
            >
              <option value="">— Select —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. UDM-Pro Andheri Main" className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Asset code *</Label>
              <Input value={form.asset_code} onChange={(e) => setForm({ ...form, asset_code: e.target.value.toUpperCase() })} className="mt-1 font-mono" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Make</Label>
              <Input value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Model</Label>
              <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="mt-1" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Serial number</Label>
              <Input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">MAC address</Label>
              <Input value={form.mac_address} onChange={(e) => setForm({ ...form, mac_address: e.target.value })} className="mt-1 font-mono" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">IP address</Label>
              <Input value={form.ip_address} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} className="mt-1 font-mono" />
            </div>
            <div>
              <Label className="text-xs">Vendor</Label>
              <Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} className="mt-1" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Purchase date</Label>
              <Input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Warranty expiry</Label>
              <Input type="date" value={form.warranty_expiry} onChange={(e) => setForm({ ...form, warranty_expiry: e.target.value })} className="mt-1" />
            </div>
          </div>

          <div>
            <Label className="text-xs">Status</Label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "maintenance" | "retired" })}
              className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
            >
              <option value="active">Active</option>
              <option value="maintenance">In maintenance</option>
              <option value="retired">Retired</option>
            </select>
          </div>

          <div>
            <Label className="text-xs">Physical location notes</Label>
            <Input value={form.location_notes} onChange={(e) => setForm({ ...form, location_notes: e.target.value })} placeholder="e.g. Server rack — Floor 2" className="mt-1" />
          </div>

          <div>
            <Label className="text-xs">Notes</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving…</> : (isEdit ? "Save" : "Add asset")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

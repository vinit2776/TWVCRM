"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Camera, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { compressImageClient } from "@/lib/uploads/compress-image-client";
import type { FacilityAsset, FacilityAssetCategory, FacilityLifecycleStage, CategoryCustomField } from "@/types";

interface Location { id: string; name: string }
interface Floor { id: string; name: string; floor_number?: number | null }

const LIFECYCLE_OPTIONS: { value: FacilityLifecycleStage; label: string }[] = [
  { value: "procured", label: "Procured" },
  { value: "installed", label: "Installed" },
  { value: "testing_commissioning", label: "Testing & Commissioning" },
  { value: "operational", label: "Operational" },
  { value: "under_amc", label: "Under AMC" },
  { value: "decommissioned", label: "Decommissioned" },
];

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
    lifecycle_stage: "operational" as FacilityLifecycleStage,
    installation_date: "",
    location_notes: "", notes: "", attention_notes: "",
  });
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [pendingPhotos, setPendingPhotos] = useState<{ file: File; preview: string }[]>([]);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const selectedCategory = useMemo(
    () => categories.find((c) => c.id === form.category_id),
    [categories, form.category_id],
  );

  const customFields: CategoryCustomField[] = useMemo(
    () => (selectedCategory?.custom_field_schema as CategoryCustomField[] | undefined) || [],
    [selectedCategory],
  );

  useEffect(() => {
    if (!open) return;
    Promise.all([
      fetch("/api/locations?is_active=true").then((r) => r.json()),
      fetch("/api/facility/categories").then((r) => r.json()),
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
      lifecycle_stage: (asset?.lifecycle_stage || "operational") as FacilityLifecycleStage,
      installation_date: asset?.installation_date?.slice(0, 10) || "",
      location_notes: asset?.location_notes || "",
      notes: asset?.notes || "",
      attention_notes: asset?.attention_notes || "",
    });
    setCustomValues((asset?.custom_field_values as Record<string, unknown>) || {});
    setPendingPhotos([]);
  }, [open, asset, defaultLocationId]);

  useEffect(() => {
    if (!form.location_id) { setFloors([]); return; }
    fetch(`/api/locations/${form.location_id}/floors`)
      .then((r) => r.json())
      .then((j) => setFloors(j.data || []));
  }, [form.location_id]);

  useEffect(() => {
    if (isEdit) return;
    if (!form.category_id || !form.location_id) {
      setForm((f) => ({ ...f, asset_code: "" }));
      return;
    }
    const cat = categories.find((c) => c.id === form.category_id);
    const loc = locations.find((l) => l.id === form.location_id);
    if (!cat || !loc) return;
    const locPrefix = (loc.name.match(/[A-Z]/g)?.slice(0, 3).join("") || "LOC").toUpperCase();
    const catPrefix = (cat.slug.split("-").pop() || cat.name.slice(0, 3)).toUpperCase().slice(0, 4);
    const prefix = `${locPrefix}-${catPrefix}-`;
    fetch(`/api/facility/assets?location_id=${form.location_id}&category_id=${form.category_id}`)
      .then((r) => r.json())
      .then((json) => {
        const existing: { asset_code?: string }[] = json.data || [];
        const nums = existing
          .map((a) => { const m = a.asset_code?.match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; })
          .filter((n) => !isNaN(n));
        const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
        setForm((f) => ({ ...f, asset_code: `${prefix}${String(next).padStart(3, "0")}` }));
      });
  }, [form.location_id, form.category_id, isEdit, categories, locations]);

  const handlePhotoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const existingCount = (asset?.photos?.length ?? 0) + pendingPhotos.length;
    const slots = 6 - existingCount;
    const toAdd = files.slice(0, slots);
    const compressed = await Promise.all(
      toAdd.map((f) => compressImageClient(f, { maxDimension: 1200, quality: 0.78 }))
    );
    const previews = compressed.map((f) => ({ file: f, preview: URL.createObjectURL(f) }));
    setPendingPhotos((p) => [...p, ...previews]);
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const removePending = (idx: number) => {
    setPendingPhotos((p) => {
      URL.revokeObjectURL(p[idx].preview);
      return p.filter((_, i) => i !== idx);
    });
  };

  const uploadPhotos = async (assetId: string) => {
    for (const { file } of pendingPhotos) {
      const fd = new FormData();
      fd.append("photo", file);
      await fetch(`/api/facility/assets/${assetId}/photos`, { method: "POST", body: fd });
    }
  };

  const submit = async () => {
    if (!form.location_id || !form.category_id || !form.name.trim() || !form.asset_code.trim()) {
      toast.error("Location, category, name and asset code are required");
      return;
    }
    for (const f of customFields) {
      if (f.required && !customValues[f.key]) {
        toast.error(`${f.label} is required`);
        return;
      }
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
          installation_date: form.installation_date || null,
          attention_notes: form.attention_notes || null,
          custom_field_values: customValues,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      if (pendingPhotos.length > 0) await uploadPhotos(json.data.id);
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
          <DialogDescription>Register a facility asset so issues and AMC visits can be tracked against it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
          {/* Location + Floor */}
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

          {/* Category */}
          <div>
            <Label className="text-xs">Category *</Label>
            <select
              value={form.category_id}
              onChange={(e) => { setForm({ ...form, category_id: e.target.value }); setCustomValues({}); }}
              className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
            >
              <option value="">— Select —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Name + Code */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Split AC Conference Room" className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Asset code</Label>
              <Input
                value={form.asset_code}
                readOnly
                placeholder="Auto-generated"
                className="mt-1 font-mono bg-muted text-muted-foreground cursor-not-allowed"
              />
            </div>
          </div>

          {/* Make + Model */}
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

          {/* Serial + MAC */}
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

          {/* IP + Vendor */}
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

          {/* Purchase + Warranty */}
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

          {/* Installation date + Lifecycle */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Installation date</Label>
              <Input type="date" value={form.installation_date} onChange={(e) => setForm({ ...form, installation_date: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Lifecycle stage</Label>
              <select
                value={form.lifecycle_stage}
                onChange={(e) => setForm({ ...form, lifecycle_stage: e.target.value as FacilityLifecycleStage })}
                className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
              >
                {LIFECYCLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {/* Status */}
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

          {/* Category-specific custom fields */}
          {customFields.length > 0 && (
            <div className="border-t pt-3 space-y-2.5">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {selectedCategory?.name} details
              </div>
              <div className="grid grid-cols-2 gap-3">
                {customFields.map((f) => (
                  <div key={f.key}>
                    <Label className="text-xs">{f.label}{f.required ? " *" : ""}</Label>
                    {f.type === "select" ? (
                      <select
                        value={String(customValues[f.key] || "")}
                        onChange={(e) => setCustomValues({ ...customValues, [f.key]: e.target.value })}
                        className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
                      >
                        <option value="">— Select —</option>
                        {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <Input
                        type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                        step={f.type === "number" ? "any" : undefined}
                        value={String(customValues[f.key] ?? "")}
                        onChange={(e) => setCustomValues({
                          ...customValues,
                          [f.key]: f.type === "number" ? (e.target.value ? Number(e.target.value) : "") : e.target.value,
                        })}
                        className="mt-1"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs">Physical location notes</Label>
            <Input value={form.location_notes} onChange={(e) => setForm({ ...form, location_notes: e.target.value })} placeholder="e.g. Server rack — Floor 2" className="mt-1" />
          </div>

          <div>
            <Label className="text-xs">Notes</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="mt-1" />
          </div>

          <div>
            <Label className="text-xs text-amber-700">⚠ Attention notes (shown to technicians on every visit)</Label>
            <textarea
              value={form.attention_notes}
              onChange={(e) => setForm({ ...form, attention_notes: e.target.value })}
              placeholder="e.g. Belt is loose — check and tighten every preventive visit"
              rows={2}
              className="mt-1 w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          </div>
          {/* Photos — optional, encouraged */}
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-1">
              <Label className="text-xs flex items-center gap-1">
                <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                Photos
                <span className="text-muted-foreground font-normal">(optional — helps technicians identify the asset on-site)</span>
              </Label>
              {((asset?.photos?.length ?? 0) + pendingPhotos.length) < 6 && (
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="text-xs text-primary underline-offset-2 hover:underline"
                >
                  + Add photo
                </button>
              )}
            </div>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handlePhotoPick}
            />
            {/* Existing saved photos */}
            {(asset?.photos?.length ?? 0) > 0 || pendingPhotos.length > 0 ? (
              <div className="flex flex-wrap gap-2 mt-2">
                {(asset?.photos || []).map((p) => (
                  <img
                    key={p.path}
                    src={p.url}
                    alt="Asset photo"
                    className="h-16 w-16 rounded-md object-cover border"
                  />
                ))}
                {pendingPhotos.map((p, i) => (
                  <div key={i} className="relative">
                    <img src={p.preview} alt="Preview" className="h-16 w-16 rounded-md object-cover border border-dashed border-primary/50" />
                    <button
                      type="button"
                      onClick={() => removePending(i)}
                      className="absolute -top-1.5 -right-1.5 bg-destructive text-white rounded-full p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="mt-1 w-full h-16 rounded-md border border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
              >
                <Camera className="h-5 w-5" />
                <span className="text-xs">Tap to add a photo of this asset</span>
              </button>
            )}
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

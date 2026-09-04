"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Camera, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
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

const STEPS = [
  { title: "Where & what", hint: "These 3 fields are required — they generate the asset's unique tracking code." },
  { title: "Specs", hint: "Fill what you know. Serial number and warranty expiry are especially useful for vendor support." },
  { title: "For technicians", hint: "Technicians see this when they scan the QR on-site. More detail = faster resolution." },
];

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{children}</p>;
}

function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className={`h-1.5 rounded-full transition-all ${i < step ? "bg-primary w-6" : "bg-muted w-3"}`} />
      ))}
    </div>
  );
}

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
  const [step, setStep] = useState(1);

  const [form, setForm] = useState({
    location_id: "", floor_id: "", category_id: "",
    name: "", asset_code: "",
    make: "", model: "", serial_number: "", mac_address: "", ip_address: "",
    purchase_date: "", warranty_expiry: "", vendor: "",
    status: "active" as "active" | "maintenance" | "retired",
    lifecycle_stage: "operational" as FacilityLifecycleStage,
    installation_date: "",
    assigned_department: "", next_service_due: "",
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

  // `categories` holds inactive ones too so the code-prefix lookup below can
  // still resolve an asset whose category was deactivated after it was created.
  // The pickers must not *offer* inactive categories though — except the one
  // this asset already has, which has to stay visible and selected.
  const selectableCategories = useMemo(
    () => categories.filter((c) => c.is_active || c.id === asset?.category_id),
    [categories, asset?.category_id],
  );

  const customFields: CategoryCustomField[] = useMemo(
    () => (selectedCategory?.custom_field_schema as CategoryCustomField[] | undefined) || [],
    [selectedCategory],
  );

  useEffect(() => {
    if (!open) return;
    Promise.all([
      fetch("/api/locations?is_active=true").then((r) => r.json()),
      fetch("/api/facility/categories?include_inactive=true").then((r) => r.json()),
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
      assigned_department: asset?.assigned_department || "",
      next_service_due: asset?.next_service_due?.slice(0, 10) || "",
      location_notes: asset?.location_notes || "",
      notes: asset?.notes || "",
      attention_notes: asset?.attention_notes || "",
    });
    setCustomValues((asset?.custom_field_values as Record<string, unknown>) || {});
    setPendingPhotos([]);
    setStep(1);
  }, [open, asset, defaultLocationId]);

  useEffect(() => {
    if (!form.location_id) { setFloors([]); return; }
    fetch(`/api/locations/${form.location_id}/floors`)
      .then((r) => r.json())
      .then((j) => setFloors(j.data || []));
  }, [form.location_id]);

  useEffect(() => {
    // Editing an asset without touching its location/category: leave the
    // existing code alone (including reverting back to it if the user tries
    // a different location/category and then changes their mind).
    if (isEdit && form.location_id === asset?.location_id && form.category_id === asset?.category_id) {
      const original = asset?.asset_code || "";
      setForm((f) => (f.asset_code === original ? f : { ...f, asset_code: original }));
      return;
    }
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
  }, [form.location_id, form.category_id, isEdit, categories, locations, asset]);

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

  const validateStep1 = () => {
    if (!form.location_id) { toast.error("Select a location first"); return false; }
    if (!form.category_id) { toast.error("Select a category"); return false; }
    if (!form.name.trim()) { toast.error("Give this asset a name"); return false; }
    if (!form.asset_code.trim()) { toast.error("Asset code not generated yet — wait a moment"); return false; }
    return true;
  };

  const validateCustomFields = () => {
    for (const f of customFields) {
      if (f.required && !customValues[f.key]) {
        toast.error(`${f.label} is required`);
        return false;
      }
    }
    return true;
  };

  const nextStep = () => {
    if (step === 1 && !validateStep1()) return;
    if (step === 2 && !validateCustomFields()) return;
    setStep((s) => s + 1);
  };

  const submit = async () => {
    if (!validateStep1()) return;
    if (!validateCustomFields()) return;
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
          assigned_department: form.assigned_department.trim() || null,
          next_service_due: form.next_service_due || null,
          custom_field_values: customValues,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      if (pendingPhotos.length > 0) await uploadPhotos(json.data.id);
      if (isEdit && asset && form.location_id !== asset.location_id) {
        const oldLocName = locations.find((l) => l.id === asset.location_id)?.name || "previous location";
        const newLocName = locations.find((l) => l.id === form.location_id)?.name || "new location";
        await fetch(`/api/facility/assets/${asset.id}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "relocation",
            note: `Moved from ${oldLocName} to ${newLocName}. Asset code updated to ${form.asset_code}.`,
          }),
        }).catch(() => null);
      }
      toast.success(
        isEdit ? "Asset updated" : "Asset added! Open it to print the QR code or attach AMC documents.",
        { duration: 5000 }
      );
      onSuccess(json.data);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  // ── Step 1: Identity ──────────────────────────────────────────────────────
  const step1 = (
    <div className="space-y-3">
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
          <Hint>Which WorkVilla site is this asset installed in?</Hint>
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
          <Hint>Optional, but helps filter on multi-floor sites.</Hint>
        </div>
      </div>

      <div>
        <Label className="text-xs">Category *</Label>
        <select
          value={form.category_id}
          onChange={(e) => { setForm({ ...form, category_id: e.target.value }); setCustomValues({}); }}
          className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
        >
          <option value="">— Select —</option>
          {selectableCategories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <Hint>Category sets the code prefix (e.g. Furniture → FURN) and unlocks category-specific fields.</Hint>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Name *</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Split AC — Conference Room 2"
            className="mt-1"
          />
          <Hint>Be specific — include the room or zone so it&apos;s easy to identify on a list.</Hint>
        </div>
        <div>
          <Label className="text-xs">Asset code</Label>
          <Input
            value={form.asset_code || ""}
            readOnly
            placeholder="Select location + category first"
            className="mt-1 font-mono bg-muted text-muted-foreground cursor-not-allowed"
          />
          <Hint>Auto-generated from your selections above. This code appears on the QR sticker.</Hint>
        </div>
      </div>
    </div>
  );

  // ── Step 2: Specs ─────────────────────────────────────────────────────────
  const step2 = (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Make</Label>
          <Input value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} placeholder="e.g. Daikin" className="mt-1" />
          <Hint>Brand name on the device — e.g. Daikin, Dell, Cisco.</Hint>
        </div>
        <div>
          <Label className="text-xs">Model</Label>
          <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="e.g. FTKG50TV" className="mt-1" />
          <Hint>From the label or invoice. Used when ordering spare parts.</Hint>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Serial number</Label>
          <Input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} className="mt-1" />
          <Hint>Printed on the device sticker. Needed for warranty claims.</Hint>
        </div>
        <div>
          <Label className="text-xs">Vendor</Label>
          <Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="e.g. Blue Star Services" className="mt-1" />
          <Hint>Who supplied or installed this asset.</Hint>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Purchase date</Label>
          <Input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} className="mt-1" />
          <Hint>Used to calculate asset age for AMC decisions.</Hint>
        </div>
        <div>
          <Label className="text-xs">Warranty expiry</Label>
          <Input type="date" value={form.warranty_expiry} onChange={(e) => setForm({ ...form, warranty_expiry: e.target.value })} className="mt-1" />
          <Hint>You&apos;ll get an alert before this lapses — don&apos;t skip it.</Hint>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Installation date</Label>
          <Input type="date" value={form.installation_date} onChange={(e) => setForm({ ...form, installation_date: e.target.value })} className="mt-1" />
          <Hint>When the asset was put into service at this location.</Hint>
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
          <Hint>Current state — update this as the asset moves through its life.</Hint>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Assigned to (employee / dept.)</Label>
          <Input value={form.assigned_department} onChange={(e) => setForm({ ...form, assigned_department: e.target.value })} placeholder="e.g. IT, or a person's name" className="mt-1" />
          <Hint>Optional — who or which team owns this asset day-to-day.</Hint>
        </div>
        <div>
          <Label className="text-xs">Next service due</Label>
          <Input type="date" value={form.next_service_due} onChange={(e) => setForm({ ...form, next_service_due: e.target.value })} className="mt-1" />
          <Hint>Optional — next planned preventive-maintenance date.</Hint>
        </div>
      </div>

      {/* Network fields — only show if category suggests it or already filled */}
      <details className="group">
        <summary className="text-xs text-muted-foreground cursor-pointer select-none list-none flex items-center gap-1 py-1">
          <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
          Network / IP details (optional — for switches, APs, UDMs)
        </summary>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div>
            <Label className="text-xs">MAC address</Label>
            <Input value={form.mac_address} onChange={(e) => setForm({ ...form, mac_address: e.target.value })} className="mt-1 font-mono" />
            <Hint>Found on the device label. Required for network device tracking.</Hint>
          </div>
          <div>
            <Label className="text-xs">IP address</Label>
            <Input value={form.ip_address} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} className="mt-1 font-mono" />
            <Hint>Static IP only — leave blank for DHCP devices.</Hint>
          </div>
        </div>
      </details>

      <div>
        <Label className="text-xs">Status</Label>
        <select
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "maintenance" | "retired" })}
          className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
        >
          <option value="active">Active — in normal use</option>
          <option value="maintenance">In maintenance — being serviced</option>
          <option value="retired">Retired — decommissioned</option>
        </select>
        <Hint>Almost always &quot;Active&quot; for new assets. Change when the asset goes for repair.</Hint>
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
    </div>
  );

  // ── Step 3: Technician reference ──────────────────────────────────────────
  const step3 = (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">Physical location notes</Label>
        <Input
          value={form.location_notes}
          onChange={(e) => setForm({ ...form, location_notes: e.target.value })}
          placeholder="e.g. Server rack — Floor 2, Bay 3, top slot"
          className="mt-1"
        />
        <Hint>Exact spot inside the building. The more precise, the faster a tech can find it without calling anyone.</Hint>
      </div>

      <div>
        <Label className="text-xs">Notes</Label>
        <Input
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="e.g. Replaced compressor in Jan 2025"
          className="mt-1"
        />
        <Hint>General history — past repairs, known quirks, anything a future tech should know.</Hint>
      </div>

      <div>
        <Label className="text-xs text-amber-700">⚠ Attention notes <span className="font-normal">(shown on every technician visit)</span></Label>
        <textarea
          value={form.attention_notes}
          onChange={(e) => setForm({ ...form, attention_notes: e.target.value })}
          placeholder="e.g. Belt is loose — check and tighten at every preventive visit"
          rows={2}
          className="mt-1 w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <Hint>Use this for recurring issues or safety warnings. Technicians see it highlighted in red every time they open this asset.</Hint>
      </div>

      {/* Photos */}
      <div className="border-t pt-3">
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs flex items-center gap-1">
            <Camera className="h-3.5 w-3.5 text-muted-foreground" />
            Photos
            <span className="text-muted-foreground font-normal">(optional)</span>
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
        <Hint>A photo of the nameplate, installation spot, or any damage — so techs can identify the asset on-site without guessing.</Hint>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handlePhotoPick}
        />
        {(asset?.photos?.length ?? 0) > 0 || pendingPhotos.length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-2">
            {(asset?.photos || []).map((p) => (
              <img key={p.path} src={p.url} alt="Asset photo" className="h-16 w-16 rounded-md object-cover border" />
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
            className="mt-2 w-full h-16 rounded-md border border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
          >
            <Camera className="h-5 w-5" />
            <span className="text-xs">Tap to add a photo of this asset</span>
          </button>
        )}
      </div>
    </div>
  );

  const stepContent = [step1, step2, step3];
  const currentStepData = STEPS[step - 1];

  // Edit mode: show all fields in a single scrollable view (no wizard)
  const flatEditContent = (
    <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Location</Label>
          <select
            value={form.location_id}
            onChange={(e) => setForm({ ...form, location_id: e.target.value, floor_id: "" })}
            className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
          >
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {form.location_id !== asset?.location_id && (
            <Hint>Changing location assigns a new asset code and logs a relocation event.</Hint>
          )}
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
        <Label className="text-xs">Category</Label>
        <select
          value={form.category_id}
          onChange={(e) => { setForm({ ...form, category_id: e.target.value }); setCustomValues({}); }}
          className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
        >
          {selectableCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.is_active ? c.name : `${c.name} (inactive)`}
            </option>
          ))}
        </select>
        {form.category_id !== asset?.category_id && (
          <Hint>Changing category assigns a new asset code and resets category-specific fields below.</Hint>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Name *</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Asset code</Label>
          <Input value={form.asset_code} readOnly className="mt-1 font-mono bg-muted text-muted-foreground cursor-not-allowed" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label className="text-xs">Make</Label><Input value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} className="mt-1" /></div>
        <div><Label className="text-xs">Model</Label><Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="mt-1" /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label className="text-xs">Serial number</Label><Input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} className="mt-1" /></div>
        <div><Label className="text-xs">MAC address</Label><Input value={form.mac_address} onChange={(e) => setForm({ ...form, mac_address: e.target.value })} className="mt-1 font-mono" /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label className="text-xs">IP address</Label><Input value={form.ip_address} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} className="mt-1 font-mono" /></div>
        <div><Label className="text-xs">Vendor</Label><Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} className="mt-1" /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label className="text-xs">Purchase date</Label><Input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} className="mt-1" /></div>
        <div><Label className="text-xs">Warranty expiry</Label><Input type="date" value={form.warranty_expiry} onChange={(e) => setForm({ ...form, warranty_expiry: e.target.value })} className="mt-1" /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label className="text-xs">Installation date</Label><Input type="date" value={form.installation_date} onChange={(e) => setForm({ ...form, installation_date: e.target.value })} className="mt-1" /></div>
        <div>
          <Label className="text-xs">Lifecycle stage</Label>
          <select value={form.lifecycle_stage} onChange={(e) => setForm({ ...form, lifecycle_stage: e.target.value as FacilityLifecycleStage })} className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm">
            {LIFECYCLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label className="text-xs">Assigned to (employee / dept.)</Label><Input value={form.assigned_department} onChange={(e) => setForm({ ...form, assigned_department: e.target.value })} placeholder="e.g. IT, or a person's name" className="mt-1" /></div>
        <div><Label className="text-xs">Next service due</Label><Input type="date" value={form.next_service_due} onChange={(e) => setForm({ ...form, next_service_due: e.target.value })} className="mt-1" /></div>
      </div>
      <div>
        <Label className="text-xs">Status</Label>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "maintenance" | "retired" })} className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm">
          <option value="active">Active</option>
          <option value="maintenance">In maintenance</option>
          <option value="retired">Retired</option>
        </select>
      </div>
      {customFields.length > 0 && (
        <div className="border-t pt-3 space-y-2.5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{selectedCategory?.name} details</div>
          <div className="grid grid-cols-2 gap-3">
            {customFields.map((f) => (
              <div key={f.key}>
                <Label className="text-xs">{f.label}{f.required ? " *" : ""}</Label>
                {f.type === "select" ? (
                  <select value={String(customValues[f.key] || "")} onChange={(e) => setCustomValues({ ...customValues, [f.key]: e.target.value })} className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm">
                    <option value="">— Select —</option>
                    {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <Input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} step={f.type === "number" ? "any" : undefined} value={String(customValues[f.key] ?? "")} onChange={(e) => setCustomValues({ ...customValues, [f.key]: f.type === "number" ? (e.target.value ? Number(e.target.value) : "") : e.target.value })} className="mt-1" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div><Label className="text-xs">Physical location notes</Label><Input value={form.location_notes} onChange={(e) => setForm({ ...form, location_notes: e.target.value })} placeholder="e.g. Server rack — Floor 2, Bay 3" className="mt-1" /></div>
      <div><Label className="text-xs">Notes</Label><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="mt-1" /></div>
      <div>
        <Label className="text-xs text-amber-700">⚠ Attention notes (shown to technicians on every visit)</Label>
        <textarea value={form.attention_notes} onChange={(e) => setForm({ ...form, attention_notes: e.target.value })} placeholder="e.g. Belt is loose — check and tighten every preventive visit" rows={2} className="mt-1 w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-400" />
      </div>
      <div className="border-t pt-3">
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs flex items-center gap-1">
            <Camera className="h-3.5 w-3.5 text-muted-foreground" />
            Photos <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          {((asset?.photos?.length ?? 0) + pendingPhotos.length) < 6 && (
            <button type="button" onClick={() => photoInputRef.current?.click()} className="text-xs text-primary underline-offset-2 hover:underline">+ Add photo</button>
          )}
        </div>
        <input ref={photoInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handlePhotoPick} />
        {(asset?.photos?.length ?? 0) > 0 || pendingPhotos.length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-2">
            {(asset?.photos || []).map((p) => <img key={p.path} src={p.url} alt="Asset photo" className="h-16 w-16 rounded-md object-cover border" />)}
            {pendingPhotos.map((p, i) => (
              <div key={i} className="relative">
                <img src={p.preview} alt="Preview" className="h-16 w-16 rounded-md object-cover border border-dashed border-primary/50" />
                <button type="button" onClick={() => removePending(i)} className="absolute -top-1.5 -right-1.5 bg-destructive text-white rounded-full p-0.5"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        ) : (
          <button type="button" onClick={() => photoInputRef.current?.click()} className="mt-1 w-full h-16 rounded-md border border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors">
            <Camera className="h-5 w-5" />
            <span className="text-xs">Tap to add a photo</span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          {isEdit ? (
            <>
              <DialogTitle>Edit asset</DialogTitle>
              <DialogDescription>Update the details for this asset.</DialogDescription>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <DialogTitle>Add asset — {currentStepData.title}</DialogTitle>
                <StepIndicator step={step} total={3} />
              </div>
              <DialogDescription>{currentStepData.hint}</DialogDescription>
            </>
          )}
        </DialogHeader>

        {isEdit ? (
          flatEditContent
        ) : (
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            {stepContent[step - 1]}
          </div>
        )}

        <DialogFooter className="flex-row justify-between gap-2">
          {isEdit ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button onClick={submit} disabled={busy}>
                {busy ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving…</> : "Save"}
              </Button>
            </>
          ) : (
            <>
              <div>
                {step > 1 && (
                  <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={busy}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
                {step < 3 ? (
                  <Button onClick={nextStep}>
                    Next <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                ) : (
                  <Button onClick={submit} disabled={busy}>
                    {busy ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving…</> : "Save asset"}
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

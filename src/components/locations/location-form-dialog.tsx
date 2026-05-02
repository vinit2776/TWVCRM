"use client";

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, MapPin, LocateFixed, FileSpreadsheet, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import type { Location, LocationCapacityConfig, LocationPrintTemplate } from "@/types";

interface LocationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location?: Location | null;
  onSuccess: () => void;
}

const AREA_TYPES: { key: keyof LocationCapacityConfig; label: string; emoji: string; placeholder: string }[] = [
  { key: "open_desk",       label: "Open Desk",       emoji: "💺", placeholder: "e.g. 40" },
  { key: "private_cabin",   label: "Private Cabin",   emoji: "🏢", placeholder: "e.g. 10" },
  { key: "meeting_room",    label: "Meeting Room",    emoji: "📋", placeholder: "e.g. 4"  },
  { key: "conference_room", label: "Conference Room", emoji: "🎯", placeholder: "e.g. 1"  },
];

export function LocationFormDialog({
  open,
  onOpenChange,
  location,
  onSuccess,
}: LocationFormDialogProps) {
  const [name, setName]       = useState("");
  const [code, setCode]       = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity]       = useState("");
  const [state, setState]     = useState("");
  const [isActive, setIsActive] = useState(true);
  const [requiresHeadcount, setRequiresHeadcount] = useState(false);
  const [capacityConfig, setCapacityConfig] = useState<Record<string, string>>({});
  const [latitude, setLatitude]   = useState<string>("");
  const [longitude, setLongitude] = useState<string>("");
  const [detectingGeo, setDetectingGeo] = useState(false);
  const [saving, setSaving]   = useState(false);

  // Print-server template — optional. The admin can upload it now or later
  // (passively from the location's edit dialog). Just stores the sample file;
  // the column-mapping editor lives in a future Batch.
  const [printTemplate, setPrintTemplate] = useState<LocationPrintTemplate | null>(null);
  const [pendingTemplateFile, setPendingTemplateFile] = useState<File | null>(null);
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const templateInputRef = useRef<HTMLInputElement>(null);

  const isEdit = !!location;

  useEffect(() => {
    if (location) {
      setName(location.name);
      setCode(location.code);
      setAddress(location.address || "");
      setCity(location.city || "");
      setState(location.state || "");
      setIsActive(location.is_active);
      setRequiresHeadcount(location.requires_headcount ?? false);
      // Convert numbers to strings for controlled inputs
      const cfg = location.capacity_config || {};
      setCapacityConfig(
        Object.fromEntries(
          AREA_TYPES.map(a => [a.key, cfg[a.key] != null ? String(cfg[a.key]) : ""])
        )
      );
      setLatitude(location.latitude != null ? String(location.latitude) : "");
      setLongitude(location.longitude != null ? String(location.longitude) : "");
      // Load any existing template so the dialog shows the current sample
      fetch(`/api/locations/${location.id}/print-template`)
        .then((r) => r.json())
        .then((j) => setPrintTemplate(j.data || null))
        .catch(() => setPrintTemplate(null));
    } else {
      setPrintTemplate(null);
      setPendingTemplateFile(null);
      setName(""); setCode(""); setAddress(""); setCity(""); setState("");
      setIsActive(true);
      setRequiresHeadcount(false);
      setCapacityConfig({});
      setLatitude(""); setLongitude("");
    }
  }, [location, open]);

  const handleCapacity = (key: string, val: string) => {
    setCapacityConfig(prev => ({ ...prev, [key]: val }));
  };

  const handleDetectLocation = () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation is not supported by your browser");
      return;
    }
    setDetectingGeo(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(String(pos.coords.latitude));
        setLongitude(String(pos.coords.longitude));
        setDetectingGeo(false);
        toast.success("Location coordinates captured");
      },
      () => {
        setDetectingGeo(false);
        toast.error("Could not detect location — please enter coordinates manually");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !code.trim()) {
      toast.error("Name and code are required");
      return;
    }

    // Build capacity_config — only include keys with valid positive numbers
    const capacity_config: Record<string, number> = {};
    for (const a of AREA_TYPES) {
      const v = parseInt(capacityConfig[a.key] || "");
      if (!isNaN(v) && v > 0) capacity_config[a.key] = v;
    }

    setSaving(true);
    try {
      const payload = {
        name, code: code.toUpperCase(), address, city, state,
        is_active: isActive,
        requires_headcount: requiresHeadcount,
        capacity_config,
        latitude:  latitude  !== "" ? parseFloat(latitude)  : null,
        longitude: longitude !== "" ? parseFloat(longitude) : null,
      };

      const res = isEdit
        ? await fetch(`/api/locations/${location.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/locations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      const json = await res.json();
      if (res.ok) {
        // If admin attached a print-server template, upload it now that the
        // location row exists. Failure here is non-fatal — they can retry from
        // the edit dialog later. Doing it after the main save keeps creation
        // semantics simple (file upload doesn't block location creation).
        const savedLocId = (json.data?.id || location?.id) as string | undefined;
        if (pendingTemplateFile && savedLocId) {
          try {
            setUploadingTemplate(true);
            const fd = new FormData();
            fd.append("file", pendingTemplateFile);
            const upRes = await fetch(`/api/locations/${savedLocId}/print-template`, {
              method: "POST",
              body: fd,
            });
            if (!upRes.ok) {
              const e = await upRes.json().catch(() => null);
              toast.warning(`Location saved, but template upload failed: ${e?.error || "unknown error"}. Try again from Edit Location.`);
            } else {
              toast.success("Print-server template attached");
            }
          } catch {
            toast.warning("Location saved, but template upload failed. Try again from Edit Location.");
          } finally {
            setUploadingTemplate(false);
          }
        }
        toast.success(isEdit ? "Location updated" : "Location created");
        onSuccess();
        onOpenChange(false);
      } else {
        toast.error(json.error || "Failed to save location");
      }
    } catch {
      toast.error("Failed to save location");
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveTemplate = async () => {
    if (!location?.id || !confirm("Remove the saved print-server template?")) return;
    const res = await fetch(`/api/locations/${location.id}/print-template`, { method: "DELETE" });
    if (res.ok) {
      setPrintTemplate(null);
      setPendingTemplateFile(null);
      toast.success("Template removed");
    } else {
      toast.error("Failed to remove template");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Location" : "Add Location"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name + Code */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="loc-name">Name *</Label>
              <Input id="loc-name" value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g., MG Road" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc-code">Code *</Label>
              <Input id="loc-code" value={code}
                onChange={e => setCode(e.target.value.toUpperCase().slice(0, 10))}
                placeholder="e.g., MGR" maxLength={10} required />
              <p className="text-xs text-muted-foreground">Short unique identifier</p>
            </div>
          </div>

          {/* Address */}
          <div className="space-y-2">
            <Label htmlFor="loc-address">Address</Label>
            <Textarea id="loc-address" value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Full address" rows={2} />
          </div>

          {/* City + State */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="loc-city">City</Label>
              <Input id="loc-city" value={city} onChange={e => setCity(e.target.value)}
                placeholder="e.g., Chennai" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc-state">State</Label>
              <Input id="loc-state" value={state} onChange={e => setState(e.target.value)}
                placeholder="e.g., Tamil Nadu" />
            </div>
          </div>

          {/* Headcount requirement */}
          <div className="flex items-center justify-between rounded-md border p-3 bg-muted/30">
            <div>
              <Label className="cursor-pointer" htmlFor="requires-headcount">Requires Headcount</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enable daily occupancy logging for this location.<br />
                Disable for fully-dedicated single-tenant spaces.
              </p>
            </div>
            <button
              id="requires-headcount"
              type="button"
              role="switch"
              aria-checked={requiresHeadcount}
              onClick={() => setRequiresHeadcount(v => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${requiresHeadcount ? "bg-[#015E65]" : "bg-input"}`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${requiresHeadcount ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>

          {/* Capacity config — only shown when headcount is enabled */}
          {requiresHeadcount && <div className="space-y-3">
            <div>
              <Label>Space Capacity</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Total seats per area type — used to calculate utilisation in headcount readings
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {AREA_TYPES.map(a => (
                <div key={a.key} className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-2.5 border border-border/50">
                  <span className="text-base shrink-0">{a.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{a.label}</p>
                    <Input
                      type="number"
                      min={0}
                      value={capacityConfig[a.key] ?? ""}
                      onChange={e => handleCapacity(a.key, e.target.value)}
                      placeholder={a.placeholder}
                      className="h-7 text-sm mt-0.5 px-2 border-0 bg-transparent p-0 focus-visible:ring-0 shadow-none"
                    />
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">seats</span>
                </div>
              ))}
            </div>
          </div>

          }

          {/* GPS Coordinates */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <Label className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />GPS Coordinates</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Used to auto-suggest this location in the Headcount screen.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDetectLocation}
                disabled={detectingGeo}
                className="shrink-0 gap-1.5"
              >
                {detectingGeo
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <LocateFixed className="h-3.5 w-3.5" />}
                {detectingGeo ? "Detecting…" : "Detect my location"}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="loc-lat" className="text-xs text-muted-foreground">Latitude</Label>
                <Input
                  id="loc-lat"
                  type="number"
                  step="any"
                  value={latitude}
                  onChange={e => setLatitude(e.target.value)}
                  placeholder="e.g. 12.9716"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="loc-lng" className="text-xs text-muted-foreground">Longitude</Label>
                <Input
                  id="loc-lng"
                  type="number"
                  step="any"
                  value={longitude}
                  onChange={e => setLongitude(e.target.value)}
                  placeholder="e.g. 77.5946"
                />
              </div>
            </div>
            {latitude && longitude && (
              <a
                href={`https://www.google.com/maps?q=${latitude},${longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-[#015E65] hover:underline mt-0.5"
              >
                <MapPin className="h-3 w-3" />
                Verify on Google Maps
              </a>
            )}
          </div>

          {/* Print-server template — optional, can be uploaded later */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <Label className="flex items-center gap-1.5">
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  Print-server template
                  <span className="text-[10px] text-muted-foreground font-normal">(optional)</span>
                </Label>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Sample monthly export from this location&apos;s print server. Used to bill print overage.
                  Skip now and upload later from Edit Location.
                </p>
              </div>
            </div>

            <input
              ref={templateInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setPendingTemplateFile(f);
              }}
            />

            {printTemplate?.sample_file_name && !pendingTemplateFile ? (
              <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  <span className="text-xs truncate">{printTemplate.sample_file_name}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button" variant="ghost" size="sm" className="h-7 text-xs"
                    onClick={() => templateInputRef.current?.click()}
                  >Replace</Button>
                  <Button
                    type="button" variant="ghost" size="sm" className="h-7 text-xs text-red-600 hover:text-red-700"
                    onClick={handleRemoveTemplate}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ) : pendingTemplateFile ? (
              <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
                <span className="text-xs truncate">
                  {uploadingTemplate ? "Uploading… " : "Will upload on save: "}
                  <span className="font-medium">{pendingTemplateFile.name}</span>
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPendingTemplateFile(null)}>
                  Clear
                </Button>
              </div>
            ) : (
              <Button
                type="button" variant="outline" size="sm" className="h-8 text-xs"
                onClick={() => templateInputRef.current?.click()}
              >
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
                Choose .xlsx file
              </Button>
            )}
          </div>

          {/* Active toggle (edit only) */}
          {isEdit && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>Active</Label>
                <p className="text-xs text-muted-foreground">Inactive locations are hidden from dropdowns</p>
              </div>
              <Button type="button" variant={isActive ? "default" : "outline"} size="sm"
                onClick={() => setIsActive(!isActive)}>
                {isActive ? "Active" : "Inactive"}
              </Button>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || !code.trim()}>
              {saving ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
              ) : isEdit ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

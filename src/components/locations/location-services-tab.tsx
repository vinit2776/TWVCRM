"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil, Wifi, Coffee, Printer, Users, Zap, Car, Camera, ConciergeBell } from "lucide-react";
import { toast } from "sonner";
import type { LocationService } from "@/types";

// ── Amenity catalogue (must stay in sync with pdf-generator.ts) ──────────────
const AMENITY_CATALOG: Array<{ key: string; label: string; icon: React.ReactNode }> = [
  { key: "wifi",         label: "Hi-speed Internet",          icon: <Wifi className="h-5 w-5" /> },
  { key: "coffee",       label: "Pantry Services",            icon: <Coffee className="h-5 w-5" /> },
  { key: "printer",      label: "Printing Facilities",        icon: <Printer className="h-5 w-5" /> },
  { key: "meeting",      label: "Conference & Meeting Rooms", icon: <Users className="h-5 w-5" /> },
  { key: "power_backup", label: "Power Backup",               icon: <Zap className="h-5 w-5" /> },
  { key: "parking",      label: "Parking Available",          icon: <Car className="h-5 w-5" /> },
  { key: "cctv",         label: "CCTV & Security",            icon: <Camera className="h-5 w-5" /> },
  { key: "reception",    label: "Reception / Front Desk",     icon: <ConciergeBell className="h-5 w-5" /> },
];

const DEFAULT_ICONS = ["wifi", "coffee", "printer", "meeting"];

interface LocationServicesTabProps {
  locationId: string;
  canEdit: boolean;
  initialAmenityIcons?: string[];
}

export function LocationServicesTab({ locationId, canEdit, initialAmenityIcons }: LocationServicesTabProps) {
  // ── Billable services ──────────────────────────────────────────────────────
  const [services, setServices] = useState<LocationService[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LocationService | null>(null);
  const [form, setForm] = useState({ name: "", unit: "nos", price_per_unit: "" });

  const fetchServices = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/location-services?location_id=${locationId}`);
    if (res.ok) {
      const json = await res.json();
      setServices(json.data || []);
    }
    setLoading(false);
  }, [locationId]);

  useEffect(() => { fetchServices(); }, [fetchServices]);

  const openNew = () => {
    setEditing(null);
    setForm({ name: "", unit: "nos", price_per_unit: "" });
    setDialogOpen(true);
  };

  const openEdit = (svc: LocationService) => {
    setEditing(svc);
    setForm({ name: svc.name, unit: svc.unit, price_per_unit: String(svc.price_per_unit) });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Service name is required"); return; }
    if (editing) {
      const res = await fetch(`/api/location-services/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, unit: form.unit, price_per_unit: parseFloat(form.price_per_unit) || 0 }),
      });
      if (res.ok) { toast.success("Service updated"); setDialogOpen(false); fetchServices(); }
      else { const err = await res.json(); toast.error(err.error || "Failed to update"); }
    } else {
      const res = await fetch("/api/location-services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: locationId, name: form.name, unit: form.unit, price_per_unit: parseFloat(form.price_per_unit) || 0 }),
      });
      if (res.ok) { toast.success("Service added"); setDialogOpen(false); fetchServices(); }
      else { const err = await res.json(); toast.error(err.error || "Failed to add"); }
    }
  };

  const toggleActive = async (svc: LocationService) => {
    const res = await fetch(`/api/location-services/${svc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !svc.is_active }),
    });
    if (res.ok) { toast.success(svc.is_active ? "Service deactivated" : "Service activated"); fetchServices(); }
  };

  // ── Proposal amenity icons ─────────────────────────────────────────────────
  const [amenityIcons, setAmenityIcons] = useState<string[]>(initialAmenityIcons ?? DEFAULT_ICONS);
  const [savingAmenities, setSavingAmenities] = useState(false);

  // Sync if parent re-renders with loaded data
  useEffect(() => {
    if (initialAmenityIcons) setAmenityIcons(initialAmenityIcons);
  }, [initialAmenityIcons]);

  const toggleAmenity = (key: string) => {
    setAmenityIcons((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const saveAmenities = async () => {
    setSavingAmenities(true);
    const res = await fetch(`/api/locations/${locationId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposal_amenity_icons: amenityIcons }),
    });
    setSavingAmenities(false);
    if (res.ok) toast.success("Proposal amenities saved");
    else toast.error("Failed to save amenities");
  };

  return (
    <div className="space-y-6">
      {/* ── Billable Services ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-base">Billable Services</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Services that can be quoted on proposals (e.g. Conference Hall, Printing)</p>
          </div>
          {canEdit && (
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" />Add Service
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}</div>
          ) : services.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No services configured. Click &quot;Add Service&quot; to create one.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Service Name</th>
                    <th className="pb-2 font-medium text-muted-foreground">Unit</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Price / Unit</th>
                    <th className="pb-2 font-medium text-muted-foreground text-center">Active</th>
                    {canEdit && <th className="pb-2 font-medium text-muted-foreground"></th>}
                  </tr>
                </thead>
                <tbody>
                  {services.map((svc) => (
                    <tr key={svc.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2.5 font-medium">{svc.name}</td>
                      <td className="py-2.5">
                        <Badge variant="outline" className="text-xs">{svc.unit}</Badge>
                      </td>
                      <td className="py-2.5 text-right font-mono">
                        {Number(svc.price_per_unit) > 0 ? `₹${Number(svc.price_per_unit).toLocaleString("en-IN")}` : "Free"}
                      </td>
                      <td className="py-2.5 text-center">
                        <Switch checked={svc.is_active} onCheckedChange={() => canEdit && toggleActive(svc)} disabled={!canEdit} />
                      </td>
                      {canEdit && (
                        <td className="py-2.5">
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openEdit(svc)}>
                            <Pencil className="h-3 w-3 mr-1" />Edit
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Proposal Amenity Icons ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Proposal Amenities</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose which amenity icons appear in the &quot;Featured Amenities&quot; strip on this location&apos;s proposals. Up to 4 icons are shown.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {AMENITY_CATALOG.map(({ key, label, icon }) => {
              const active = amenityIcons.includes(key);
              return (
                <button
                  key={key}
                  onClick={() => canEdit && toggleAmenity(key)}
                  disabled={!canEdit}
                  className={`flex flex-col items-center gap-2 rounded-lg border-2 p-3 text-center text-xs font-medium transition-colors ${
                    active
                      ? "border-[#015E65] bg-[#015E65]/5 text-[#015E65]"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span className={active ? "text-[#015E65]" : "text-muted-foreground"}>{icon}</span>
                  {label}
                </button>
              );
            })}
          </div>
          {amenityIcons.length > 4 && (
            <p className="text-xs text-amber-600">Only the first 4 selected icons will appear in the PDF.</p>
          )}
          {canEdit && (
            <div className="flex justify-end">
              <Button size="sm" onClick={saveAmenities} disabled={savingAmenities}>
                {savingAmenities ? "Saving…" : "Save Amenities"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Add / Edit Service Dialog ─────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Service" : "Add Service"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Service Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Conference Hall" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Unit</Label>
                <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nos">nos</SelectItem>
                    <SelectItem value="hours">hours</SelectItem>
                    <SelectItem value="days">days</SelectItem>
                    <SelectItem value="pages">pages</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Price per Unit (₹)</Label>
                <Input type="number" value={form.price_per_unit} onChange={(e) => setForm({ ...form, price_per_unit: e.target.value })} placeholder="0 = free" />
              </div>
            </div>
            <Button onClick={handleSave} className="w-full">
              {editing ? "Save Changes" : "Add Service"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

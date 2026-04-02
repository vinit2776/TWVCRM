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
import { Plus, Pencil } from "lucide-react";
import { toast } from "sonner";
import { LocationSelector } from "@/components/shared/location-selector";
import type { LocationService } from "@/types";

export function ServicesSettings() {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [services, setServices] = useState<LocationService[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LocationService | null>(null);
  const [form, setForm] = useState({ name: "", unit: "nos", price_per_unit: "" });

  const fetchServices = useCallback(async () => {
    if (!locationId) { setServices([]); return; }
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
      if (res.ok) {
        toast.success("Service updated");
        setDialogOpen(false);
        fetchServices();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to update");
      }
    } else {
      const res = await fetch("/api/location-services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: locationId, name: form.name, unit: form.unit, price_per_unit: parseFloat(form.price_per_unit) || 0 }),
      });
      if (res.ok) {
        toast.success("Service added");
        setDialogOpen(false);
        fetchServices();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to add");
      }
    }
  };

  const toggleActive = async (svc: LocationService) => {
    const res = await fetch(`/api/location-services/${svc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !svc.is_active }),
    });
    if (res.ok) {
      toast.success(svc.is_active ? "Service deactivated" : "Service activated");
      fetchServices();
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Location Services</CardTitle>
        <div className="flex items-center gap-3">
          <LocationSelector value={locationId} onValueChange={setLocationId} placeholder="Select center..." />
          {locationId && (
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" />Add Service
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!locationId ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Select a location to manage its services.</p>
        ) : loading ? (
          <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}</div>
        ) : services.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No services configured for this location. Click &quot;Add Service&quot; to create one.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 font-medium text-muted-foreground">Service Name</th>
                  <th className="pb-2 font-medium text-muted-foreground">Unit</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">Price / Unit</th>
                  <th className="pb-2 font-medium text-muted-foreground text-center">Active</th>
                  <th className="pb-2 font-medium text-muted-foreground"></th>
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
                      <Switch checked={svc.is_active} onCheckedChange={() => toggleActive(svc)} />
                    </td>
                    <td className="py-2.5">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openEdit(svc)}>
                        <Pencil className="h-3 w-3 mr-1" />Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Service" : "Add Service"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Service Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Conference Hall"
                />
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
                  <Input
                    type="number"
                    value={form.price_per_unit}
                    onChange={(e) => setForm({ ...form, price_per_unit: e.target.value })}
                    placeholder="0 = free"
                  />
                </div>
              </div>
              <Button onClick={handleSave} className="w-full">
                {editing ? "Save Changes" : "Add Service"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

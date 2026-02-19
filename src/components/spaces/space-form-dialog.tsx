"use client";

import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useLocations } from "@/hooks/use-locations";
import { DEFAULT_FACILITIES } from "@/lib/constants";
import type { Space, SpaceOperatingHours } from "@/types";

interface SpaceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  space?: Space | null;
  onSuccess: () => void;
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_LABELS: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

const DEFAULT_OPERATING_HOURS: SpaceOperatingHours = {
  monday: { open: "09:00", close: "19:00", is_open: true },
  tuesday: { open: "09:00", close: "19:00", is_open: true },
  wednesday: { open: "09:00", close: "19:00", is_open: true },
  thursday: { open: "09:00", close: "19:00", is_open: true },
  friday: { open: "09:00", close: "19:00", is_open: true },
  saturday: { open: "09:00", close: "14:00", is_open: true },
  sunday: { open: "09:00", close: "14:00", is_open: false },
};

interface FacilityRow {
  name: string;
  is_complimentary: boolean;
  charge_per_use: number;
}

export function SpaceFormDialog({ open, onOpenChange, space, onSuccess }: SpaceFormDialogProps) {
  const { locations } = useLocations();
  const isEdit = !!space;

  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [capacity, setCapacity] = useState(10);
  const [hourlyRate, setHourlyRate] = useState(500);
  const [description, setDescription] = useState("");
  const [operatingHours, setOperatingHours] = useState<SpaceOperatingHours>(DEFAULT_OPERATING_HOURS);
  const [maxAdvanceDays, setMaxAdvanceDays] = useState(30);
  const [minBookingMinutes, setMinBookingMinutes] = useState(60);
  const [cancellationPolicy, setCancellationPolicy] = useState("");
  const [facilities, setFacilities] = useState<FacilityRow[]>([]);
  const [newFacility, setNewFacility] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (space) {
      setName(space.name);
      setLocationId(space.location_id);
      setCapacity(space.capacity);
      setHourlyRate(space.hourly_rate);
      setDescription(space.description || "");
      setOperatingHours(space.operating_hours || DEFAULT_OPERATING_HOURS);
      setMaxAdvanceDays(space.max_advance_booking_days);
      setMinBookingMinutes(space.min_booking_minutes);
      setCancellationPolicy(space.cancellation_policy || "");
      setFacilities(
        (space.facilities || []).map(f => ({
          name: f.name,
          is_complimentary: f.is_complimentary,
          charge_per_use: f.charge_per_use,
        }))
      );
    } else {
      setName("");
      setLocationId("");
      setCapacity(10);
      setHourlyRate(500);
      setDescription("");
      setOperatingHours(DEFAULT_OPERATING_HOURS);
      setMaxAdvanceDays(30);
      setMinBookingMinutes(60);
      setCancellationPolicy("");
      setFacilities(DEFAULT_FACILITIES.map(f => ({ name: f, is_complimentary: true, charge_per_use: 0 })));
    }
  }, [space, open]);

  const updateOperatingDay = (day: string, field: string, value: string | boolean) => {
    setOperatingHours(prev => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }));
  };

  const addFacility = () => {
    const trimmed = newFacility.trim();
    if (!trimmed) return;
    if (facilities.some(f => f.name.toLowerCase() === trimmed.toLowerCase())) {
      toast.error("Facility already exists");
      return;
    }
    setFacilities(prev => [...prev, { name: trimmed, is_complimentary: true, charge_per_use: 0 }]);
    setNewFacility("");
  };

  const removeFacility = (index: number) => {
    setFacilities(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !locationId) {
      toast.error("Name and location are required");
      return;
    }
    if (capacity < 1 || hourlyRate <= 0) {
      toast.error("Capacity and hourly rate must be positive");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        location_id: locationId,
        capacity,
        hourly_rate: hourlyRate,
        description: description.trim() || undefined,
        operating_hours: operatingHours,
        max_advance_booking_days: maxAdvanceDays,
        min_booking_minutes: minBookingMinutes,
        cancellation_policy: cancellationPolicy.trim() || undefined,
        facilities,
      };

      const res = isEdit
        ? await fetch(`/api/spaces/${space.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/spaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      const json = await res.json();
      if (res.ok) {
        toast.success(isEdit ? "Space updated" : "Space created");
        onSuccess();
        onOpenChange(false);
      } else {
        toast.error(json.error || "Failed to save space");
      }
    } catch {
      toast.error("Failed to save space");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Space" : "Add Space"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="space-name">Name *</Label>
                <Input
                  id="space-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Board Room"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="space-location">Location *</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger id="space-location"><SelectValue placeholder="Select location" /></SelectTrigger>
                  <SelectContent>
                    {locations.map(loc => (
                      <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="space-capacity">Capacity (seats)</Label>
                <Input
                  id="space-capacity"
                  type="number"
                  min={1}
                  value={capacity}
                  onChange={(e) => setCapacity(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="space-rate">Hourly Rate (INR)</Label>
                <Input
                  id="space-rate"
                  type="number"
                  min={0}
                  step={50}
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="space-desc">Description</Label>
              <Textarea
                id="space-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Room description, amenities..."
                rows={2}
              />
            </div>
          </div>

          {/* Operating Hours */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Operating Hours</Label>
            <div className="space-y-2">
              {DAYS.map(day => (
                <div key={day} className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant={operatingHours[day]?.is_open ? "default" : "outline"}
                    size="sm"
                    className="w-[52px] text-xs"
                    onClick={() => updateOperatingDay(day, "is_open", !operatingHours[day]?.is_open)}
                  >
                    {DAY_LABELS[day]}
                  </Button>
                  {operatingHours[day]?.is_open ? (
                    <>
                      <Input
                        type="time"
                        value={operatingHours[day]?.open || "09:00"}
                        onChange={(e) => updateOperatingDay(day, "open", e.target.value)}
                        className="w-[120px]"
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="time"
                        value={operatingHours[day]?.close || "19:00"}
                        onChange={(e) => updateOperatingDay(day, "close", e.target.value)}
                        className="w-[120px]"
                      />
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">Closed</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Booking Policies */}
          <div className="space-y-4">
            <Label className="text-base font-semibold">Booking Policies</Label>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="max-advance">Max Advance Booking (days)</Label>
                <Input
                  id="max-advance"
                  type="number"
                  min={1}
                  value={maxAdvanceDays}
                  onChange={(e) => setMaxAdvanceDays(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="min-booking">Min Booking (minutes)</Label>
                <Input
                  id="min-booking"
                  type="number"
                  min={30}
                  step={30}
                  value={minBookingMinutes}
                  onChange={(e) => setMinBookingMinutes(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cancellation">Cancellation Policy</Label>
              <Textarea
                id="cancellation"
                value={cancellationPolicy}
                onChange={(e) => setCancellationPolicy(e.target.value)}
                placeholder="e.g., Free cancellation up to 2 hours before"
                rows={2}
              />
            </div>
          </div>

          {/* Facilities */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Facilities</Label>
            {facilities.length > 0 && (
              <div className="space-y-2">
                {facilities.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="flex-1">{f.name}</span>
                    <Button
                      type="button"
                      variant={f.is_complimentary ? "outline" : "secondary"}
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => {
                        const updated = [...facilities];
                        updated[i] = { ...f, is_complimentary: !f.is_complimentary, charge_per_use: f.is_complimentary ? 100 : 0 };
                        setFacilities(updated);
                      }}
                    >
                      {f.is_complimentary ? "Free" : `₹${f.charge_per_use}`}
                    </Button>
                    {!f.is_complimentary && (
                      <Input
                        type="number"
                        min={0}
                        value={f.charge_per_use}
                        onChange={(e) => {
                          const updated = [...facilities];
                          updated[i] = { ...f, charge_per_use: Number(e.target.value) };
                          setFacilities(updated);
                        }}
                        className="w-[80px] h-7 text-xs"
                      />
                    )}
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeFacility(i)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                placeholder="Add facility..."
                value={newFacility}
                onChange={(e) => setNewFacility(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFacility(); } }}
                className="flex-1"
              />
              <Button type="button" variant="outline" size="sm" onClick={addFacility}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !name.trim() || !locationId}>
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

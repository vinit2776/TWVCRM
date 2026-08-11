"use client";

import { useState, useEffect, useCallback } from "react";
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
import { preventEnterSubmit } from "@/lib/utils";
import type { Space, SpaceOperatingHours, SpacePricingModel } from "@/types";

interface CosecDevice { id: string; label: string; device_ip: string; }

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
  const [workspaceType, setWorkspaceType] = useState("__none");
  const [capacity, setCapacity] = useState(10);
  const [pricingModel, setPricingModel] = useState<SpacePricingModel>("hourly");
  const [hourlyRate, setHourlyRate] = useState(500);
  const [dailyRate, setDailyRate] = useState(500);
  const [description, setDescription] = useState("");
  const [operatingHours, setOperatingHours] = useState<SpaceOperatingHours>(DEFAULT_OPERATING_HOURS);
  const [maxAdvanceDays, setMaxAdvanceDays] = useState(30);
  const [minBookingMinutes, setMinBookingMinutes] = useState(60);
  const [minBookingMinutesContract, setMinBookingMinutesContract] = useState(30);
  const [cancellationPolicy, setCancellationPolicy] = useState("");
  const [facilities, setFacilities] = useState<FacilityRow[]>([]);
  const [newFacility, setNewFacility] = useState("");
  const [cosecDeviceId, setCosecDeviceId] = useState<string>("__none");
  const [cosecDevices, setCosecDevices] = useState<CosecDevice[]>([]);
  const [saving, setSaving] = useState(false);

  const loadCosecDevices = useCallback(async (locId: string) => {
    if (!locId) { setCosecDevices([]); return; }
    // Only fetch business_centre devices — entry_point readers are not linkable to spaces
    const res = await fetch(`/api/cosec/devices?location_id=${locId}&category=business_centre`);
    if (res.ok) {
      const json = await res.json();
      setCosecDevices(json.data ?? []);
    }
  }, []);

  useEffect(() => {
    if (locationId) loadCosecDevices(locationId);
    else setCosecDevices([]);
  }, [locationId, loadCosecDevices]);

  // Clear device link when workspace type changes away from conference/meeting room
  const ROOM_TYPES_WITH_ACCESS = ["conference_room", "meeting_room"];
  const showCosecSelector = ROOM_TYPES_WITH_ACCESS.includes(workspaceType);

  useEffect(() => {
    if (space) {
      setName(space.name);
      setLocationId(space.location_id);
      setWorkspaceType(space.workspace_type || "__none");
      setCapacity(space.capacity);
      setPricingModel(space.pricing_model || "hourly");
      setHourlyRate(space.hourly_rate);
      setDailyRate(Number(space.daily_rate ?? space.hourly_rate ?? 0));
      setDescription(space.description || "");
      setOperatingHours(space.operating_hours || DEFAULT_OPERATING_HOURS);
      setMaxAdvanceDays(space.max_advance_booking_days);
      setMinBookingMinutes(space.min_booking_minutes);
      setMinBookingMinutesContract(space.min_booking_minutes_contract ?? 30);
      setCancellationPolicy(space.cancellation_policy || "");
      setFacilities(
        (space.facilities || []).map(f => ({
          name: f.name,
          is_complimentary: f.is_complimentary,
          charge_per_use: f.charge_per_use,
        }))
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCosecDeviceId((space as any).cosec_device_id ?? "__none");
    } else {
      setName("");
      setLocationId("");
      setWorkspaceType("__none");
      setCapacity(10);
      setPricingModel("hourly");
      setHourlyRate(500);
      setDailyRate(500);
      setDescription("");
      setOperatingHours(DEFAULT_OPERATING_HOURS);
      setMaxAdvanceDays(30);
      setMinBookingMinutes(60);
      setMinBookingMinutesContract(30);
      setCancellationPolicy("");
      setFacilities(DEFAULT_FACILITIES.map(f => ({ name: f, is_complimentary: true, charge_per_use: 0 })));
      setCosecDeviceId("__none");
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
    if (capacity < 1) {
      toast.error("Capacity must be positive");
      return;
    }
    if (pricingModel === "hourly" && hourlyRate <= 0) {
      toast.error("Hourly rate must be positive");
      return;
    }
    if (pricingModel === "daily" && dailyRate <= 0) {
      toast.error("Daily rate must be positive");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        location_id: locationId,
        workspace_type: (workspaceType && workspaceType !== "__none") ? workspaceType : undefined,
        capacity,
        pricing_model: pricingModel,
        // Rate the API stores as the unit rate. For daily-priced spaces we send 0
        // for hourly and the day rate in daily_rate; the migration accepts both.
        hourly_rate: pricingModel === "daily" ? 0 : hourlyRate,
        daily_rate: pricingModel === "daily" ? dailyRate : null,
        description: description.trim() || undefined,
        operating_hours: operatingHours,
        max_advance_booking_days: maxAdvanceDays,
        // Day-pass spaces have no minimum booking duration — they cover the full
        // operating day by definition. Store 0 so the booking API skips the check.
        min_booking_minutes: pricingModel === "daily" ? 0 : minBookingMinutes,
        // Contract-holder minimum — only meaningful for conference/meeting rooms; harmless elsewhere.
        min_booking_minutes_contract: pricingModel === "daily" ? 0 : minBookingMinutesContract,
        cancellation_policy: cancellationPolicy.trim() || undefined,
        facilities,
        cosec_device_id: (cosecDeviceId && cosecDeviceId !== "__none") ? cosecDeviceId : null,
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

        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-6">
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
                <Label htmlFor="space-pricing-model">Pricing Model</Label>
                <Select value={pricingModel} onValueChange={(v) => setPricingModel(v as SpacePricingModel)}>
                  <SelectTrigger id="space-pricing-model"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hourly">Hourly (rate × hours booked)</SelectItem>
                    <SelectItem value="daily">Daily / Day Pass (flat day rate)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {pricingModel === "hourly" ? (
              <div className="space-y-2">
                <Label htmlFor="space-rate">Hourly Rate (INR, ex-GST)</Label>
                <Input
                  id="space-rate"
                  type="number"
                  min={0}
                  step={50}
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(Number(e.target.value))}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="space-day-rate">Day Rate (INR, ex-GST)</Label>
                <Input
                  id="space-day-rate"
                  type="number"
                  min={0}
                  step={50}
                  value={dailyRate}
                  onChange={(e) => setDailyRate(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Charged once per booking. Times auto-set to centre operating hours.
                  Extras (extended time, F&amp;B, services) are added at check-out.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="space-workspace-type">Space Type</Label>
              <Select value={workspaceType} onValueChange={(v) => {
                setWorkspaceType(v);
                if (!ROOM_TYPES_WITH_ACCESS.includes(v)) setCosecDeviceId("__none");
              }}>
                <SelectTrigger id="space-workspace-type"><SelectValue placeholder="Select type (optional)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">None</SelectItem>
                  <SelectItem value="hot_desk">Hot Desk</SelectItem>
                  <SelectItem value="dedicated_desk">Dedicated Desk</SelectItem>
                  <SelectItem value="private_office">Private Office</SelectItem>
                  <SelectItem value="meeting_room">Meeting Room</SelectItem>
                  <SelectItem value="conference_room">Conference Room</SelectItem>
                  <SelectItem value="virtual_office">Virtual Office</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {showCosecSelector && (
              <div className="space-y-2">
                <Label htmlFor="space-cosec">Business Centre Access Device <span className="text-muted-foreground text-xs">(optional)</span></Label>
                {cosecDevices.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No business centre COSEC devices configured at this location. Set them up under Admin → COSEC Devices.</p>
                ) : (
                  <>
                    <Select value={cosecDeviceId} onValueChange={setCosecDeviceId}>
                      <SelectTrigger id="space-cosec"><SelectValue placeholder="No device linked" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">None</SelectItem>
                        {cosecDevices.map(d => (
                          <SelectItem key={d.id} value={d.id}>{d.label} — {d.device_ip}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Link a business centre device to this room. Booking guests will receive a PIN valid for this room and the entry doors for the duration of their booking.</p>
                  </>
                )}
              </div>
            )}

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
              {pricingModel !== "daily" && (
                <div className="space-y-2">
                  <Label htmlFor="min-booking">
                    {showCosecSelector ? "Min Booking — Walk-in (minutes)" : "Min Booking (minutes)"}
                  </Label>
                  <Input
                    id="min-booking"
                    type="number"
                    min={30}
                    step={30}
                    value={minBookingMinutes}
                    onChange={(e) => setMinBookingMinutes(Number(e.target.value))}
                  />
                </div>
              )}
              {pricingModel !== "daily" && showCosecSelector && (
                <div className="space-y-2">
                  <Label htmlFor="min-booking-contract">Min Booking — Contract Holder (minutes)</Label>
                  <Input
                    id="min-booking-contract"
                    type="number"
                    min={30}
                    step={30}
                    value={minBookingMinutesContract}
                    onChange={(e) => setMinBookingMinutesContract(Number(e.target.value))}
                  />
                </div>
              )}
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

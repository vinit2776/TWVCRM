"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Clock, Users, IndianRupee } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useLocations } from "@/hooks/use-locations";
import { formatCurrency } from "@/lib/utils";
import { BOOKING_CUSTOMER_TYPE_LABELS, PAYMENT_MODES, PAYMENT_MODE_LABELS } from "@/lib/constants";
import { toast } from "sonner";
import type { Space, SpaceFacility } from "@/types";

interface AvailableSlot {
  start: string;
  end: string;
}

interface ContractOption {
  id: string;
  contract_number: string;
  lead?: { id: string; first_name: string; last_name: string; company?: string; email?: string; phone?: string };
}

interface LeadOption {
  id: string;
  first_name: string;
  last_name: string;
  company?: string;
  email?: string;
  phone?: string;
}

function NewBookingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedSpaceId = searchParams.get("space_id") || "";

  const { locations } = useLocations();
  const [saving, setSaving] = useState(false);

  // Step 1: Room selection
  const [locationId, setLocationId] = useState("");
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceId, setSpaceId] = useState(preselectedSpaceId);
  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null);
  const [bookingDate, setBookingDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [availableSlots, setAvailableSlots] = useState<AvailableSlot[]>([]);
  const [availLoading, setAvailLoading] = useState(false);

  // Step 2: Time
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  // Step 3: Customer
  const [customerType, setCustomerType] = useState<"contract_holder" | "walk_in" | "guest">("walk_in");
  const [contractId, setContractId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestCompany, setGuestCompany] = useState("");

  // Step 4: Facilities
  const [selectedFacilities, setSelectedFacilities] = useState<string[]>([]);

  // Step 5: Payment & Notes
  const [paymentMode, setPaymentMode] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");

  // Data for dropdowns
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [leads, setLeads] = useState<LeadOption[]>([]);

  // Fetch spaces when location changes
  useEffect(() => {
    if (!locationId) { setSpaces([]); return; }
    fetch(`/api/spaces?location_id=${locationId}&is_active=true&limit=50`)
      .then(r => r.json())
      .then(json => setSpaces(json.data || []))
      .catch(() => setSpaces([]));
  }, [locationId]);

  // If preselected space, set location too
  useEffect(() => {
    if (preselectedSpaceId) {
      fetch(`/api/spaces/${preselectedSpaceId}`)
        .then(r => r.json())
        .then(json => {
          if (json.data) {
            setSelectedSpace(json.data);
            setLocationId(json.data.location_id);
            setSpaceId(json.data.id);
          }
        })
        .catch(() => {});
    }
  }, [preselectedSpaceId]);

  // Fetch space details when spaceId changes
  useEffect(() => {
    if (!spaceId) { setSelectedSpace(null); return; }
    const found = spaces.find(s => s.id === spaceId);
    if (found) {
      setSelectedSpace(found);
    } else if (spaceId && !preselectedSpaceId) {
      fetch(`/api/spaces/${spaceId}`)
        .then(r => r.json())
        .then(json => setSelectedSpace(json.data || null))
        .catch(() => setSelectedSpace(null));
    }
  }, [spaceId, spaces, preselectedSpaceId]);

  // Fetch availability
  const fetchAvailability = useCallback(async () => {
    if (!spaceId || !bookingDate) return;
    setAvailLoading(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/availability?date=${bookingDate}`);
      if (res.ok) {
        const json = await res.json();
        setAvailableSlots(json.available_slots || []);
      }
    } catch { /* ignore */ }
    setAvailLoading(false);
  }, [spaceId, bookingDate]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  // Fetch contracts for dropdown
  useEffect(() => {
    if (customerType === "contract_holder" || customerType === "guest") {
      const params = new URLSearchParams({ status: "active", limit: "100" });
      if (locationId) params.set("location_id", locationId);
      fetch(`/api/contracts?${params}`)
        .then(r => r.json())
        .then(json => setContracts(json.data || []))
        .catch(() => setContracts([]));
    }
  }, [customerType, locationId]);

  // Fetch leads for walk-in dropdown
  useEffect(() => {
    if (customerType === "walk_in") {
      fetch("/api/leads?limit=100&status=won")
        .then(r => r.json())
        .then(json => setLeads(json.data || []))
        .catch(() => setLeads([]));
    }
  }, [customerType]);

  // Calculate pricing
  const durationHours = (() => {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
  })();

  const roomCost = selectedSpace ? durationHours * selectedSpace.hourly_rate : 0;
  const facilityCost = selectedSpace?.facilities
    ? selectedSpace.facilities
        .filter(f => selectedFacilities.includes(f.id) && !f.is_complimentary)
        .reduce((sum, f) => sum + f.charge_per_use, 0)
    : 0;
  const totalAmount = roomCost + facilityCost;

  // Build time dropdown options from available slots
  const timeOptions = (() => {
    const times = new Set<string>();
    availableSlots.forEach(slot => {
      times.add(slot.start);
      times.add(slot.end);
    });
    return Array.from(times).sort();
  })();

  const endTimeOptions = (() => {
    if (!startTime) return [];
    return timeOptions.filter(t => t > startTime);
  })();

  const handleSubmit = async () => {
    if (!spaceId || !bookingDate || !startTime || !endTime) {
      toast.error("Please select room, date, and time");
      return;
    }
    if (durationHours < (selectedSpace?.min_booking_minutes || 60) / 60) {
      toast.error(`Minimum booking is ${selectedSpace?.min_booking_minutes || 60} minutes`);
      return;
    }
    if (customerType === "contract_holder" && !contractId) {
      toast.error("Please select a contract");
      return;
    }
    if (customerType === "walk_in" && !leadId && !guestName.trim()) {
      toast.error("Please select a lead or enter guest details");
      return;
    }
    if (customerType === "guest" && !contractId) {
      toast.error("Please select the host contract");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        space_id: spaceId,
        booking_date: bookingDate,
        start_time: startTime,
        end_time: endTime,
        customer_type: customerType,
        contract_id: contractId || undefined,
        lead_id: leadId || undefined,
        guest_name: guestName.trim() || undefined,
        guest_email: guestEmail.trim() || undefined,
        guest_phone: guestPhone.trim() || undefined,
        guest_company: guestCompany.trim() || undefined,
        facility_ids: selectedFacilities,
        payment_mode: paymentMode || undefined,
        payment_reference: paymentReference.trim() || undefined,
        notes: notes.trim() || undefined,
      };

      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (res.ok) {
        const bookingId = json.data?.id;
        toast.success(`Booking ${json.data?.booking_number} created`);

        // Send confirmation email
        if (bookingId) {
          fetch(`/api/bookings/${bookingId}/email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "confirmation" }),
          }).catch(() => {});
        }

        router.push(bookingId ? `/bookings/${bookingId}` : "/bookings");
      } else {
        toast.error(json.error || "Failed to create booking");
      }
    } catch {
      toast.error("Failed to create booking");
    } finally {
      setSaving(false);
    }
  };

  const formatTime12 = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/bookings")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Booking</h1>
          <p className="text-sm text-muted-foreground">Book a meeting or conference room</p>
        </div>
      </div>

      {/* Room Selection */}
      <Card>
        <CardHeader><CardTitle className="text-base">1. Select Room</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Location *</Label>
              <Select value={locationId} onValueChange={(val) => { setLocationId(val); setSpaceId(""); setSelectedSpace(null); }}>
                <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
                <SelectContent>
                  {locations.map(loc => <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Room *</Label>
              <Select value={spaceId} onValueChange={setSpaceId} disabled={!locationId}>
                <SelectTrigger><SelectValue placeholder="Select room" /></SelectTrigger>
                <SelectContent>
                  {spaces.map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.capacity} seats, {formatCurrency(s.hourly_rate)}/hr)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Date *</Label>
              <Input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} />
            </div>
          </div>

          {/* Availability */}
          {spaceId && bookingDate && (
            <div className="pt-2">
              <div className="flex items-center gap-2 mb-2">
                <Label className="text-sm text-muted-foreground">Available Slots</Label>
                {availLoading && <Loader2 className="h-3 w-3 animate-spin" />}
              </div>
              {availableSlots.length === 0 ? (
                <p className="text-sm text-muted-foreground">{availLoading ? "Loading..." : "No slots available or room is closed on this day."}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {availableSlots.map((slot, i) => (
                    <Badge key={i} variant="outline" className="text-xs bg-green-50 text-green-700 cursor-pointer hover:bg-green-100"
                      onClick={() => { setStartTime(slot.start); setEndTime(slot.end); }}
                    >
                      {formatTime12(slot.start)} – {formatTime12(slot.end)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Time Selection */}
      <Card>
        <CardHeader><CardTitle className="text-base">2. Select Time</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Start Time *</Label>
              <Select value={startTime} onValueChange={(val) => { setStartTime(val); if (endTime && val >= endTime) setEndTime(""); }}>
                <SelectTrigger><SelectValue placeholder="Start time" /></SelectTrigger>
                <SelectContent>
                  {timeOptions.map(t => <SelectItem key={t} value={t}>{formatTime12(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>End Time *</Label>
              <Select value={endTime} onValueChange={setEndTime} disabled={!startTime}>
                <SelectTrigger><SelectValue placeholder="End time" /></SelectTrigger>
                <SelectContent>
                  {endTimeOptions.map(t => <SelectItem key={t} value={t}>{formatTime12(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Duration</Label>
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border bg-muted/30">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{durationHours > 0 ? `${durationHours} hour(s)` : "—"}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Customer */}
      <Card>
        <CardHeader><CardTitle className="text-base">3. Customer Details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            {(["contract_holder", "walk_in", "guest"] as const).map(type => (
              <Button
                key={type}
                type="button"
                variant={customerType === type ? "default" : "outline"}
                size="sm"
                onClick={() => { setCustomerType(type); setContractId(""); setLeadId(""); setGuestName(""); setGuestEmail(""); setGuestPhone(""); setGuestCompany(""); }}
              >
                {BOOKING_CUSTOMER_TYPE_LABELS[type]}
              </Button>
            ))}
          </div>

          {/* Contract Holder */}
          {customerType === "contract_holder" && (
            <div className="space-y-2">
              <Label>Active Contract *</Label>
              <Select value={contractId} onValueChange={setContractId}>
                <SelectTrigger><SelectValue placeholder="Select contract" /></SelectTrigger>
                <SelectContent>
                  {contracts.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contract_number} — {c.lead?.company || `${c.lead?.first_name} ${c.lead?.last_name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Booking amount will be posted to their billing.</p>
            </div>
          )}

          {/* Walk-in */}
          {customerType === "walk_in" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Select Existing Lead (optional)</Label>
                <Select value={leadId} onValueChange={setLeadId}>
                  <SelectTrigger><SelectValue placeholder="Search leads..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— No lead (guest details below) —</SelectItem>
                    {leads.map(l => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.first_name} {l.last_name} {l.company ? `(${l.company})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(!leadId || leadId === "none") && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Guest Name *</Label>
                    <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Full name" />
                  </div>
                  <div className="space-y-2">
                    <Label>Guest Email</Label>
                    <Input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="email@example.com" />
                  </div>
                  <div className="space-y-2">
                    <Label>Guest Phone</Label>
                    <Input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="Phone number" />
                  </div>
                  <div className="space-y-2">
                    <Label>Guest Company</Label>
                    <Input value={guestCompany} onChange={(e) => setGuestCompany(e.target.value)} placeholder="Company name" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Guest of contract holder */}
          {customerType === "guest" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Host Contract *</Label>
                <Select value={contractId} onValueChange={setContractId}>
                  <SelectTrigger><SelectValue placeholder="Select host contract" /></SelectTrigger>
                  <SelectContent>
                    {contracts.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.contract_number} — {c.lead?.company || `${c.lead?.first_name} ${c.lead?.last_name}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Booking amount will be posted to the host&apos;s billing.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Guest Name *</Label>
                  <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Full name" />
                </div>
                <div className="space-y-2">
                  <Label>Guest Email</Label>
                  <Input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="email@example.com" />
                </div>
                <div className="space-y-2">
                  <Label>Guest Phone</Label>
                  <Input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="Phone number" />
                </div>
                <div className="space-y-2">
                  <Label>Guest Company</Label>
                  <Input value={guestCompany} onChange={(e) => setGuestCompany(e.target.value)} placeholder="Company name" />
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Facilities */}
      {selectedSpace?.facilities && selectedSpace.facilities.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">4. Facilities</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {selectedSpace.facilities.filter(f => f.is_available).map((f: SpaceFacility) => (
                <div key={f.id} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id={`fac-${f.id}`}
                    checked={selectedFacilities.includes(f.id)}
                    onChange={(e) => {
                      setSelectedFacilities(prev =>
                        e.target.checked ? [...prev, f.id] : prev.filter(id => id !== f.id)
                      );
                    }}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <label htmlFor={`fac-${f.id}`} className="text-sm flex-1 cursor-pointer">
                    {f.name}
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {f.is_complimentary ? "Free" : formatCurrency(f.charge_per_use)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payment & Notes (for walk-ins) */}
      {customerType === "walk_in" && (
        <Card>
          <CardHeader><CardTitle className="text-base">5. Payment</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Mode</Label>
                <Select value={paymentMode} onValueChange={setPaymentMode}>
                  <SelectTrigger><SelectValue placeholder="Select mode" /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_MODES.map(m => <SelectItem key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Payment Reference</Label>
                <Input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="UPI Ref / Transaction ID" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Payment can also be recorded later from the booking detail page.</p>
          </CardContent>
        </Card>
      )}

      {/* Notes */}
      <Card>
        <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
        <CardContent>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any special requirements..." rows={3} />
        </CardContent>
      </Card>

      {/* Summary & Submit */}
      <Card className="border-primary/30">
        <CardHeader><CardTitle className="text-base">Booking Summary</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Room</p>
              <p className="font-medium text-sm">{selectedSpace?.name || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Date</p>
              <p className="font-medium text-sm">{bookingDate || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Time</p>
              <p className="font-medium text-sm">
                {startTime && endTime ? `${formatTime12(startTime)} – ${formatTime12(endTime)}` : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Duration</p>
              <p className="font-medium text-sm">{durationHours > 0 ? `${durationHours}h` : "—"}</p>
            </div>
          </div>
          <div className="border-t pt-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Room ({durationHours}h x {selectedSpace ? formatCurrency(selectedSpace.hourly_rate) : "—"})</span>
              <span>{formatCurrency(roomCost)}</span>
            </div>
            {facilityCost > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Facilities</span>
                <span>{formatCurrency(facilityCost)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-base pt-1 border-t">
              <span>Total</span>
              <span className="flex items-center gap-1">
                <IndianRupee className="h-4 w-4" />
                {formatCurrency(totalAmount)}
              </span>
            </div>
          </div>

          <Button
            className="w-full mt-4"
            size="lg"
            onClick={handleSubmit}
            disabled={saving || !spaceId || !startTime || !endTime || durationHours <= 0}
          >
            {saving ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating Booking...</>
            ) : (
              "Confirm Booking"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function NewBookingPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
      <NewBookingForm />
    </Suspense>
  );
}

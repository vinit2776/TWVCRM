"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Clock, IndianRupee, Search, Phone, User2, Building2, Banknote, CreditCard, Smartphone, Repeat, ListOrdered, Link2 } from "lucide-react";
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
import { BOOKING_CUSTOMER_TYPE_LABELS, PAYMENT_MODES, PAYMENT_MODE_LABELS, BOOKING_PAYMENT_MODES, BOOKING_PAYMENT_MODE_LABELS, RECURRENCE_FREQUENCIES } from "@/lib/constants";
import { toast } from "sonner";
import type { Space, SpaceFacility } from "@/types";
import { CustomerHistoryCard } from "@/components/bookings/customer-history-card";
import { BookingNotesTemplates } from "@/components/bookings/booking-notes-templates";
import { WaitlistDialog } from "@/components/bookings/waitlist-dialog";
import { CreateRecurringDialog } from "@/components/bookings/create-recurring-dialog";

interface AvailableSlot {
  start_time: string;
  end_time: string;
}

interface ContractOption {
  id: string;
  contract_number: string;
  lead?: { id: string; first_name: string; last_name: string; company?: string; email?: string; phone?: string };
}

interface CustomerSuggestion {
  type: "lead" | "past_guest" | "contract";
  id?: string;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
  contract_id?: string;
  contract_number?: string;
  lead_id?: string;
}

function NewBookingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedSpaceId = searchParams.get("space_id") || "";
  const preselectedCustomerType = searchParams.get("customer_type") || "";

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
  const [customRate, setCustomRate] = useState<string>("");

  // Step 2: Time
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  // Step 3: Customer — phone-first search
  const [bookerPhone, setBookerPhone] = useState("");
  const [customerSearchQuery, setCustomerSearchQuery] = useState("");
  const [customerSuggestions, setCustomerSuggestions] = useState<CustomerSuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const [customerType, setCustomerType] = useState<"contract_holder" | "walk_in" | "guest">(
    (preselectedCustomerType as "contract_holder" | "walk_in" | "guest") || "walk_in"
  );
  const [contractId, setContractId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestCompany, setGuestCompany] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSuggestion | null>(null);

  // Contracts for contract_holder/guest type
  const [contracts, setContracts] = useState<ContractOption[]>([]);

  // Step 4: Facilities
  const [selectedFacilities, setSelectedFacilities] = useState<string[]>([]);

  // Step 5: Payment & Notes
  const [paymentMode, setPaymentMode] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");
  const [collectAdvancePayment, setCollectAdvancePayment] = useState(false);
  const [advancePaymentMode, setAdvancePaymentMode] = useState<string>("cash");
  const [advancePaymentReference, setAdvancePaymentReference] = useState("");
  const [advancePaymentAmount, setAdvancePaymentAmount] = useState("");

  // Recurring booking
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringDialogOpen, setRecurringDialogOpen] = useState(false);

  // Waitlist
  const [waitlistDialogOpen, setWaitlistDialogOpen] = useState(false);
  const [slotConflict, setSlotConflict] = useState(false);

  // --- Customer Search ---
  const searchCustomers = useCallback(async (q: string) => {
    if (q.length < 3) { setCustomerSuggestions([]); return; }
    setSearchLoading(true);
    try {
      const res = await fetch(`/api/bookings/search-customer?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const json = await res.json();
        setCustomerSuggestions(json.data || []);
        setShowSuggestions(true);
      }
    } catch { /* ignore */ }
    setSearchLoading(false);
  }, []);

  const handleSearchInput = (val: string) => {
    setCustomerSearchQuery(val);
    // Also set as booker phone if it looks like a phone number (digits, +, spaces)
    if (/^[\d+\s()-]+$/.test(val)) {
      setBookerPhone(val.replace(/\s/g, ""));
    }
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => searchCustomers(val), 300);
  };

  const selectCustomerSuggestion = (sug: CustomerSuggestion) => {
    setSelectedCustomer(sug);
    setBookerPhone(sug.phone || "");
    setCustomerSearchQuery(sug.phone ? `${sug.phone} — ${sug.name}` : sug.name);
    setShowSuggestions(false);

    if (sug.type === "contract") {
      setCustomerType("contract_holder");
      setContractId(sug.contract_id || "");
      setLeadId(sug.lead_id || "");
      setGuestName("");
    } else if (sug.type === "lead") {
      setCustomerType("walk_in");
      setLeadId(sug.lead_id || sug.id || "");
      setContractId("");
      setGuestName(sug.name);
      setGuestEmail(sug.email || "");
      setGuestPhone(sug.phone || "");
      setGuestCompany(sug.company || "");
    } else {
      // past_guest
      setCustomerType("walk_in");
      setLeadId("");
      setContractId("");
      setGuestName(sug.name);
      setGuestEmail(sug.email || "");
      setGuestPhone(sug.phone || "");
      setGuestCompany(sug.company || "");
    }
  };

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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

  // Sync customRate when selected space changes
  useEffect(() => {
    setCustomRate(selectedSpace ? selectedSpace.hourly_rate.toFixed(2) : "");
  }, [selectedSpace]);

  // Fetch availability
  const fetchAvailability = useCallback(async () => {
    if (!spaceId || !bookingDate) return;
    setAvailLoading(true);
    setSlotConflict(false);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/availability?date=${bookingDate}`);
      if (res.ok) {
        const json = await res.json();
        setAvailableSlots(json.data?.available_slots || []);
      }
    } catch { /* ignore */ }
    setAvailLoading(false);
  }, [spaceId, bookingDate]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  // Merge adjacent 30-min slots into continuous availability windows
  const availabilityWindows = (() => {
    if (availableSlots.length === 0) return [];
    const sorted = [...availableSlots].sort((a, b) => a.start_time.localeCompare(b.start_time));
    const windows: { start_time: string; end_time: string }[] = [];
    let current = { ...sorted[0] };

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_time === current.end_time) {
        current.end_time = sorted[i].end_time;
      } else {
        windows.push(current);
        current = { ...sorted[i] };
      }
    }
    windows.push(current);
    return windows;
  })();

  // Check for slot conflicts when start/end time changes
  // Uses merged availability windows so multi-slot bookings don't false-positive
  useEffect(() => {
    if (!startTime || !endTime || !spaceId || !bookingDate) {
      setSlotConflict(false);
      return;
    }
    // Check if the selected time falls within a continuous availability window
    const isAvailable = availabilityWindows.some(window =>
      startTime >= window.start_time && endTime <= window.end_time
    );
    setSlotConflict(!isAvailable && availableSlots.length > 0);
  }, [startTime, endTime, availabilityWindows, availableSlots, spaceId, bookingDate]);

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

  // Calculate pricing
  const durationHours = (() => {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
  })();

  const parsedCustomRate = parseFloat(customRate);
  const effectiveRate = selectedSpace
    ? (!isNaN(parsedCustomRate) && parsedCustomRate >= 0 ? parsedCustomRate : selectedSpace.hourly_rate)
    : 0;
  const roomCost = selectedSpace ? durationHours * effectiveRate : 0;
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
      times.add(slot.start_time);
      times.add(slot.end_time);
    });
    return Array.from(times).sort();
  })();

  const minBookingMin = selectedSpace?.min_booking_minutes || 60;

  const endTimeOptions = (() => {
    if (!startTime) return [];
    const [sh, sm] = startTime.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const minEndMin = startMin + minBookingMin; // Enforce minimum booking duration
    return timeOptions.filter(t => {
      const [h, m] = t.split(":").map(Number);
      const tMin = h * 60 + m;
      return tMin >= minEndMin;
    });
  })();

  const handleSubmit = async () => {
    if (!bookerPhone.trim()) {
      toast.error("Mobile number is mandatory");
      return;
    }
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
      // Build advance_payment object if collecting at booking time
      let advancePayment: { amount: number; payment_mode: string; payment_reference?: string } | undefined;
      if (collectAdvancePayment && customerType === "walk_in") {
        const advAmt = parseFloat(advancePaymentAmount);
        if (advAmt > 0 && (advancePaymentMode === "cash" || advancePaymentMode === "card")) {
          advancePayment = {
            amount: advAmt,
            payment_mode: advancePaymentMode,
            payment_reference: advancePaymentReference.trim() || undefined,
          };
        }
      }

      const payload = {
        space_id: spaceId,
        booking_date: bookingDate,
        start_time: startTime,
        end_time: endTime,
        customer_type: customerType,
        contract_id: contractId || undefined,
        lead_id: leadId || undefined,
        booker_phone: bookerPhone.trim(),
        guest_name: guestName.trim() || undefined,
        guest_email: guestEmail.trim() || undefined,
        guest_phone: guestPhone.trim() || undefined,
        guest_company: guestCompany.trim() || undefined,
        facility_ids: selectedFacilities,
        payment_mode: paymentMode || undefined,
        payment_reference: paymentReference.trim() || undefined,
        notes: notes.trim() || undefined,
        hourly_rate: effectiveRate,
        advance_payment: advancePayment,
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

        // If Send Link mode → auto-create payment link (fire-and-forget)
        if (collectAdvancePayment && advancePaymentMode === "send_link" && bookingId) {
          fetch("/api/payments/create-payment-link", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ booking_id: bookingId }),
          })
            .then((r) => r.json())
            .then((json) => {
              if (json.data?.payment_link_url) {
                toast.success("Payment link sent to customer via SMS & email");
              } else {
                toast.error(json.error || "Failed to send payment link");
              }
            })
            .catch(() => toast.error("Failed to send payment link"));
        }

        // If advance payment was UPI/Razorpay → redirect to detail page to complete
        if (collectAdvancePayment && (advancePaymentMode === "upi" || advancePaymentMode === "razorpay")) {
          toast.info("Redirecting to booking page to complete payment...");
          router.push(bookingId ? `/bookings/${bookingId}?collect_payment=true` : "/bookings");
        } else {
          router.push(bookingId ? `/bookings/${bookingId}` : "/bookings");
        }
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

  const clearCustomerSelection = () => {
    setSelectedCustomer(null);
    setCustomerSearchQuery("");
    setBookerPhone("");
    setCustomerType("walk_in");
    setContractId("");
    setLeadId("");
    setGuestName("");
    setGuestEmail("");
    setGuestPhone("");
    setGuestCompany("");
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
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {availabilityWindows.map((window, i) => {
                      // Calculate window duration in minutes
                      const [ws, wm] = window.start_time.split(":").map(Number);
                      const [we, wme] = window.end_time.split(":").map(Number);
                      const windowDuration = (we * 60 + wme) - (ws * 60 + wm);
                      const durationLabel = windowDuration >= 60
                        ? `${(windowDuration / 60).toFixed(windowDuration % 60 ? 1 : 0)}hr`
                        : `${windowDuration}min`;

                      return (
                        <Badge
                          key={i}
                          variant="outline"
                          className="text-xs bg-green-50 text-green-700 cursor-pointer hover:bg-green-100"
                          onClick={() => {
                            setStartTime(window.start_time);
                            // Auto-set end time to start + min booking duration, capped at window end
                            const autoEndMin = Math.min(ws * 60 + wm + minBookingMin, we * 60 + wme);
                            const autoEndH = Math.floor(autoEndMin / 60);
                            const autoEndM = autoEndMin % 60;
                            setEndTime(`${String(autoEndH).padStart(2, "0")}:${String(autoEndM).padStart(2, "0")}`);
                          }}
                        >
                          {formatTime12(window.start_time)} – {formatTime12(window.end_time)} ({durationLabel})
                        </Badge>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Min booking: {minBookingMin} min, then 30-min increments. Click a window to auto-fill times.
                  </p>
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

          {/* Slot conflict — Waitlist prompt */}
          {slotConflict && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ListOrdered className="h-4 w-4 text-amber-600" />
                  <p className="text-sm text-amber-800 font-medium">This time slot is not available</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-amber-700 border-amber-300 hover:bg-amber-100"
                  onClick={() => setWaitlistDialogOpen(true)}
                  disabled={!bookerPhone.trim()}
                >
                  Join Waitlist
                </Button>
              </div>
              <p className="text-xs text-amber-700 mt-1">
                You can join the waitlist and be notified when the slot becomes available.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Customer — Phone-first search */}
      <Card>
        <CardHeader><CardTitle className="text-base">3. Customer Details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {/* Phone search bar */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Phone className="h-3.5 w-3.5" />
              Search by Mobile Number or Name *
            </Label>
            <div className="relative" ref={suggestionsRef}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={customerSearchQuery}
                onChange={(e) => handleSearchInput(e.target.value)}
                onFocus={() => customerSuggestions.length > 0 && setShowSuggestions(true)}
                placeholder="Enter mobile number, name, or company..."
                className="pl-9"
              />
              {searchLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}

              {/* Dropdown suggestions */}
              {showSuggestions && customerSuggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 border rounded-md bg-white shadow-lg max-h-64 overflow-y-auto">
                  {customerSuggestions.map((sug, i) => (
                    <button
                      key={i}
                      type="button"
                      className="w-full px-3 py-2.5 text-left hover:bg-muted/50 border-b last:border-b-0 transition-colors"
                      onClick={() => selectCustomerSuggestion(sug)}
                    >
                      <div className="flex items-center gap-2">
                        {sug.type === "contract" ? (
                          <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 shrink-0">Contract</Badge>
                        ) : sug.type === "lead" ? (
                          <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 shrink-0">Lead</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 shrink-0">Past Guest</Badge>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <User2 className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="truncate">{sug.name}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                            {sug.phone && <span className="flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{sug.phone}</span>}
                            {sug.company && <span className="flex items-center gap-1"><Building2 className="h-2.5 w-2.5" />{sug.company}</span>}
                            {sug.contract_number && <span className="font-mono">{sug.contract_number}</span>}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Type at least 3 characters. Searches across contracts, leads, and past bookings.</p>
          </div>

          {/* Selected customer info */}
          {selectedCustomer && (
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-[10px] ${
                    selectedCustomer.type === "contract" ? "bg-emerald-50 text-emerald-700" :
                    selectedCustomer.type === "lead" ? "bg-blue-50 text-blue-700" :
                    "bg-purple-50 text-purple-700"
                  }`}>
                    {selectedCustomer.type === "contract" ? "Contract Holder" : selectedCustomer.type === "lead" ? "Lead" : "Past Guest"}
                  </Badge>
                  <span className="text-sm font-medium">{selectedCustomer.name}</span>
                </div>
                <Button variant="ghost" size="sm" className="text-xs h-7" onClick={clearCustomerSelection}>Clear</Button>
              </div>
              <div className="flex gap-4 text-xs text-muted-foreground">
                {selectedCustomer.phone && <span>📱 {selectedCustomer.phone}</span>}
                {selectedCustomer.email && <span>✉ {selectedCustomer.email}</span>}
                {selectedCustomer.company && <span>🏢 {selectedCustomer.company}</span>}
                {selectedCustomer.contract_number && <span>📋 {selectedCustomer.contract_number}</span>}
              </div>
            </div>
          )}

          {/* Booker phone (always visible, mandatory) */}
          <div className="space-y-2">
            <Label>Booker Mobile Number *</Label>
            <Input
              value={bookerPhone}
              onChange={(e) => setBookerPhone(e.target.value)}
              placeholder="+91 98765 43210"
              required
            />
            <p className="text-xs text-muted-foreground">Mandatory. This is the primary contact for the booking.</p>
          </div>

          {/* Customer type selector */}
          <div className="flex gap-2">
            {(["contract_holder", "walk_in", "guest"] as const).map(type => (
              <Button
                key={type}
                type="button"
                variant={customerType === type ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setCustomerType(type);
                  if (!selectedCustomer) {
                    setContractId(""); setLeadId(""); setGuestName(""); setGuestEmail(""); setGuestPhone(""); setGuestCompany("");
                  }
                }}
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
          {customerType === "walk_in" && !selectedCustomer && (
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

          {/* Walk-in with selected customer — show read-only */}
          {customerType === "walk_in" && selectedCustomer && (
            <div className="text-xs text-muted-foreground">
              Customer details loaded from {selectedCustomer.type === "lead" ? "lead" : "past booking"} record.
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

      {/* Customer History */}
      {bookerPhone && bookerPhone.length >= 10 && (
        <CustomerHistoryCard phone={bookerPhone} leadId={leadId || undefined} />
      )}

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
            {/* Advance payment toggle */}
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="collect-advance"
                checked={collectAdvancePayment}
                onChange={(e) => {
                  setCollectAdvancePayment(e.target.checked);
                  if (e.target.checked && !advancePaymentAmount) {
                    setAdvancePaymentAmount(totalAmount > 0 ? totalAmount.toFixed(2) : "");
                  }
                }}
                className="h-4 w-4 rounded border-gray-300"
              />
              <label htmlFor="collect-advance" className="text-sm font-medium cursor-pointer">
                Collect advance payment now
              </label>
            </div>

            {collectAdvancePayment && (
              <div className="border rounded-lg p-4 space-y-4 bg-muted/20">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="1"
                      value={advancePaymentAmount}
                      onChange={(e) => setAdvancePaymentAmount(e.target.value)}
                      placeholder={`Total: ${formatCurrency(totalAmount)}`}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Payment Method</Label>
                    <div className="flex gap-1.5 flex-wrap">
                      {[
                        { mode: "cash", icon: Banknote, label: "Cash" },
                        { mode: "card", icon: CreditCard, label: "Card" },
                        { mode: "upi", icon: Smartphone, label: "UPI" },
                        { mode: "send_link", icon: Link2, label: "Send Link" },
                      ].map(({ mode, icon: Icon, label }) => (
                        <Button
                          key={mode}
                          type="button"
                          variant={advancePaymentMode === mode ? "default" : "outline"}
                          size="sm"
                          className="text-xs flex-1 gap-1"
                          onClick={() => setAdvancePaymentMode(mode)}
                        >
                          <Icon className="h-3.5 w-3.5" />{label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {(advancePaymentMode === "card" || advancePaymentMode === "upi") && (
                    <div className="space-y-2">
                      <Label>Reference</Label>
                      <Input
                        value={advancePaymentReference}
                        onChange={(e) => setAdvancePaymentReference(e.target.value)}
                        placeholder={advancePaymentMode === "upi" ? "UPI Ref / UTR" : "Transaction ID"}
                      />
                    </div>
                  )}
                </div>

                {advancePaymentMode === "cash" && (
                  <p className="text-xs text-green-700 bg-green-50 rounded px-2.5 py-1.5">
                    <Banknote className="inline h-3.5 w-3.5 mr-1" />
                    Cash payment of {formatCurrency(parseFloat(advancePaymentAmount) || 0)} will be recorded as collected.
                  </p>
                )}
                {advancePaymentMode === "upi" && (
                  <p className="text-xs text-amber-700 bg-amber-50 rounded px-2.5 py-1.5">
                    <Smartphone className="inline h-3.5 w-3.5 mr-1" />
                    After booking is created, you&apos;ll be redirected to complete UPI payment with QR code &amp; screenshot upload.
                  </p>
                )}
                {advancePaymentMode === "send_link" && (
                  <p className="text-xs text-blue-700 bg-blue-50 rounded px-2.5 py-1.5">
                    <Link2 className="inline h-3.5 w-3.5 mr-1" />
                    A Razorpay payment link will be sent to the customer via SMS and email after the booking is created.
                  </p>
                )}
              </div>
            )}

            {!collectAdvancePayment && (
              <p className="text-xs text-muted-foreground">
                Payment can be collected later from the booking detail page before check-in.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Notes with templates */}
      <Card>
        <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any special requirements..." rows={3} />
          <BookingNotesTemplates
            onInsert={(text) => {
              setNotes(prev => prev ? `${prev}\n${text}` : text);
            }}
          />
        </CardContent>
      </Card>

      {/* Make Recurring */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Repeat className="h-4 w-4" />
            Recurring Booking
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Want to book this room on a recurring schedule?</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Set up daily, weekly, bi-weekly, or monthly bookings
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRecurringDialogOpen(true)}
              disabled={!spaceId || !startTime || !endTime || !locationId}
            >
              <Repeat className="mr-1 h-4 w-4" />
              Set Up Recurring
            </Button>
          </div>
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
            {selectedSpace && (
              <div className="flex justify-between text-sm items-center">
                <span className="text-muted-foreground">Hourly Rate</span>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-xs">₹</span>
                  <Input
                    type="number" min="0" step="0.01"
                    value={customRate}
                    onChange={(e) => setCustomRate(e.target.value)}
                    className="h-6 w-20 text-right text-xs px-1"
                  />
                  <span className="text-muted-foreground text-xs">/hr</span>
                </div>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Room ({durationHours}h)</span>
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
            disabled={saving || !spaceId || !startTime || !endTime || durationHours <= 0 || !bookerPhone.trim()}
          >
            {saving ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating Booking...</>
            ) : (
              "Confirm Booking"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Dialogs */}
      {spaceId && startTime && endTime && locationId && (
        <CreateRecurringDialog
          open={recurringDialogOpen}
          onOpenChange={setRecurringDialogOpen}
          prefill={{
            space_id: spaceId,
            customer_type: customerType,
            contract_id: contractId || undefined,
            lead_id: leadId || undefined,
            booker_phone: bookerPhone,
            guest_name: guestName || undefined,
            guest_email: guestEmail || undefined,
            guest_phone: guestPhone || undefined,
            guest_company: guestCompany || undefined,
            start_time: startTime,
            end_time: endTime,
          }}
          onCreated={() => {
            router.push("/bookings");
          }}
        />
      )}

      {spaceId && startTime && endTime && (
        <WaitlistDialog
          open={waitlistDialogOpen}
          onOpenChange={setWaitlistDialogOpen}
          spaceId={spaceId}
          bookingDate={bookingDate}
          startTime={startTime}
          endTime={endTime}
          customerType={customerType}
          contractId={contractId || undefined}
          leadId={leadId || undefined}
          guestName={guestName || undefined}
          guestPhone={guestPhone || undefined}
          bookerPhone={bookerPhone}
          onAdded={() => {
            toast.success("Added to waitlist");
          }}
        />
      )}
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

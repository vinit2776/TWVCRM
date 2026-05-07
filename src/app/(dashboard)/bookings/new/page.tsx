"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Clock, IndianRupee, Search, Phone, User2, Building2, Banknote, CreditCard, Smartphone, Repeat, ListOrdered, Link2, TicketCheck, AlertTriangle } from "lucide-react";
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
import { useDebounced } from "@/hooks/use-debounced";
import { formatCurrency } from "@/lib/utils";
import { BOOKING_CUSTOMER_TYPE_LABELS, PAYMENT_MODES, PAYMENT_MODE_LABELS, BOOKING_PAYMENT_MODES, BOOKING_PAYMENT_MODE_LABELS, RECURRENCE_FREQUENCIES } from "@/lib/constants";
import { toast } from "sonner";
import type { Space, SpaceFacility, PrepaidPurchase } from "@/types";
import { CustomerHistoryCard } from "@/components/bookings/customer-history-card";
import { PrepaidBanner } from "@/components/packages/prepaid-banner";
import { BookingCreditBanner } from "@/components/bookings/booking-credit-banner";
import { LeadCautionsBanner } from "@/components/leads/lead-cautions-banner";
import type { BookingCredit } from "@/types";
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
  const [sendSms, setSendSms] = useState(true);
  const [sendWhatsapp, setSendWhatsapp] = useState(false); // disabled until WhatsApp setup complete

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
  const [bookerGstNumber, setBookerGstNumber] = useState("");
  const [gstError, setGstError] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSuggestion | null>(null);

  // Attendee count — drives multi-voucher issuance (1 voucher per 2 attendees)
  const [numAttendees, setNumAttendees] = useState<string>("");

  // ID proof
  const [idProofFile, setIdProofFile] = useState<File | null>(null);
  const [leadHasIdProof, setLeadHasIdProof] = useState(false);
  const [idProofLookingUp, setIdProofLookingUp] = useState(false);

  // Contracts for contract_holder/guest type
  const [contracts, setContracts] = useState<ContractOption[]>([]);

  // Outstanding charges from past bookings
  const [outstandingCharges, setOutstandingCharges] = useState<{ id: string; description: string; total: number; notes?: string; quantity?: number; unit_price?: number; charge_date?: string; proof_path?: string; booking?: { booking_number: string; booking_date: string } }[]>([]);
  const [selectedChargeIds, setSelectedChargeIds] = useState<Set<string>>(new Set());
  const [expandedChargeId, setExpandedChargeId] = useState<string | null>(null);

  // Step 4: Facilities
  const [selectedFacilities, setSelectedFacilities] = useState<string[]>([]);

  // Step 5: Payment & Notes
  const [paymentMode, setPaymentMode] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");
  const [aggregatorBookingId, setAggregatorBookingId] = useState("");
  const [collectAdvancePayment, setCollectAdvancePayment] = useState(false);
  const [advancePaymentMode, setAdvancePaymentMode] = useState<string>("cash");
  const [advancePaymentReference, setAdvancePaymentReference] = useState("");
  const [advancePaymentAmount, setAdvancePaymentAmount] = useState("");
  const [razorpayEnabled, setRazorpayEnabled] = useState(false);

  // Recurring booking
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringDialogOpen, setRecurringDialogOpen] = useState(false);

  // Prepaid package detection
  const [activePurchase, setActivePurchase] = useState<PrepaidPurchase | null>(null);
  const [usePrepaid, setUsePrepaid] = useState(true);

  // Partial-checkout carry-forward credit (separate from prepaid packs).
  // Surfaces only when the customer's phone has an active credit at the
  // selected centre. Lifted to this level so the booking submit can pick
  // up credit_id + hours_to_redeem.
  const [appliedCredit, setAppliedCredit] = useState<
    | { credit: BookingCredit & { hours_remaining: number }; hours_to_redeem: number }
    | null
  >(null);

  // Clear an applied credit if the user changes phone or centre — the
  // applied credit's location_id / phone might no longer match.
  useEffect(() => {
    setAppliedCredit(null);
  }, [bookerPhone, locationId]);

  // Lead caution acknowledgement gate — staff must explicitly tick
  // "I've seen this" on every danger-severity caution before they can
  // submit the booking. Lifted from LeadCautionsBanner via callback.
  const [allDangerCautionsAcked, setAllDangerCautionsAcked] = useState(true);
  // Reset to "all acked" whenever the lead changes — the banner will
  // re-evaluate and lock again if the new lead has danger cautions.
  useEffect(() => {
    setAllDangerCautionsAcked(true);
  }, [leadId]);
  const [prepaidChecking, setPrepaidChecking] = useState(false);

  // Waitlist
  const [waitlistDialogOpen, setWaitlistDialogOpen] = useState(false);
  const [slotConflict, setSlotConflict] = useState(false);

  // Debounced selectors — used by the heavy effect chains so that rapid
  // changes (e.g. user clicking through customer suggestions, picking a
  // different date, switching customer type) only fire one fetch at the end
  // instead of one per intermediate value. 250ms is below human perception
  // for most users and big enough to coalesce typical click cascades.
  const debouncedLeadId        = useDebounced(leadId, 250);
  const debouncedSpaceId       = useDebounced(spaceId, 250);
  const debouncedBookingDate   = useDebounced(bookingDate, 250);
  const debouncedLocationId    = useDebounced(locationId, 250);
  const debouncedGuestCompany  = useDebounced(guestCompany, 350);
  const debouncedCustomerType  = useDebounced(customerType, 250);

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

  // Fetch Razorpay enabled status
  useEffect(() => {
    fetch("/api/settings/public").then(r => r.json()).then(json => {
      if (json.data?.razorpay_enabled === "true") setRazorpayEnabled(true);
    }).catch(() => {});
  }, []);

  // Check if lead already has ID proof when phone is entered
  useEffect(() => {
    const phone = bookerPhone.replace(/\s/g, "");
    if (phone.length < 10 || (customerType !== "walk_in" && customerType !== "guest")) {
      setLeadHasIdProof(false);
      return;
    }
    // If we have a selectedCustomer lead_id, check directly
    const checkLeadId = leadId;
    if (!checkLeadId) {
      // lookup by phone
      setIdProofLookingUp(true);
      fetch(`/api/leads?phone_exact=${encodeURIComponent(phone)}`)
        .then(r => r.json())
        .then(json => {
          const lead = (json.data || [])[0];
          setLeadHasIdProof(!!(lead?.id_proof_path));
        })
        .catch(() => setLeadHasIdProof(false))
        .finally(() => setIdProofLookingUp(false));
    } else {
      // Lookup by lead_id
      setIdProofLookingUp(true);
      fetch(`/api/leads/${checkLeadId}`)
        .then(r => r.json())
        .then(json => setLeadHasIdProof(!!(json.data?.id_proof_path)))
        .catch(() => setLeadHasIdProof(false))
        .finally(() => setIdProofLookingUp(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookerPhone, leadId, customerType]);

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

  // Day-pass spaces use a flat daily rate (₹X/day) instead of hours × rate.
  // The rate that flows through the booking is the daily_rate; times are
  // auto-set to the centre's operating hours for that day.
  const isDayPass = selectedSpace?.pricing_model === "daily";

  // Sync customRate when selected space changes
  useEffect(() => {
    if (!selectedSpace) { setCustomRate(""); return; }
    const rate = isDayPass
      ? Number(selectedSpace.daily_rate ?? 0)
      : Number(selectedSpace.hourly_rate ?? 0);
    setCustomRate(rate.toFixed(2));
  }, [selectedSpace, isDayPass]);

  // For day passes: auto-set start/end to the centre's operating hours for the
  // chosen booking date. The user never picks times.
  useEffect(() => {
    if (!isDayPass || !selectedSpace || !bookingDate) return;
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const dayKey = days[new Date(bookingDate + "T00:00:00").getDay()];
    const hours = selectedSpace.operating_hours?.[dayKey];
    if (hours?.is_open) {
      setStartTime(hours.open);
      setEndTime(hours.close);
    }
  }, [isDayPass, selectedSpace, bookingDate]);

  // Day-pass capacity tracking — replaces the slot-availability concept.
  // For day-pass spaces, we don't care about hourly slot conflicts; we only
  // care whether the per-day capacity has been exhausted at the location.
  const [dayPassUsed, setDayPassUsed] = useState(0);

  // Fetch availability — only for hourly spaces. Day-pass uses dayPassUsed below.
  // Reads debounced selectors so rapid date-picker / space-dropdown changes
  // don't fire one network request per intermediate value.
  const fetchAvailability = useCallback(async () => {
    if (!debouncedSpaceId || !debouncedBookingDate) return;
    if (isDayPass) {
      // Don't run the slot-availability machinery for day-pass spaces.
      // It would otherwise show "no slots available" because day passes
      // already cover the full operating window (which the conference-room
      // overlap algorithm interprets as a conflict).
      setAvailableSlots([]);
      setSlotConflict(false);
      return;
    }
    setAvailLoading(true);
    setSlotConflict(false);
    try {
      const res = await fetch(`/api/spaces/${debouncedSpaceId}/availability?date=${debouncedBookingDate}`);
      if (res.ok) {
        const json = await res.json();
        setAvailableSlots(json.data?.available_slots || []);
      }
    } catch { /* ignore */ }
    setAvailLoading(false);
  }, [debouncedSpaceId, debouncedBookingDate, isDayPass]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  // Day-pass capacity counter — fetch how many day passes are already booked
  // for this date at this space, so we can show "3 of 13 day passes booked".
  useEffect(() => {
    if (!isDayPass || !debouncedSpaceId || !debouncedBookingDate) { setDayPassUsed(0); return; }
    let cancelled = false;
    fetch(`/api/bookings?space_id=${debouncedSpaceId}&date_from=${debouncedBookingDate}&date_to=${debouncedBookingDate}&limit=200`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const rows = (j.data || []) as Array<{ status: string }>;
        const live = rows.filter((b) => ["confirmed", "checked_in", "checked_out"].includes(b.status));
        setDayPassUsed(live.length);
      })
      .catch(() => { if (!cancelled) setDayPassUsed(0); });
    return () => { cancelled = true; };
  }, [isDayPass, debouncedSpaceId, debouncedBookingDate]);

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

  // Fetch outstanding charges when customer is selected (debounced lead_id)
  useEffect(() => {
    if (!debouncedLeadId) { setOutstandingCharges([]); return; }
    let cancelled = false;
    fetch(`/api/usage-charges?lead_id=${debouncedLeadId}&status=pending&limit=50`)
      .then(r => r.json())
      .then(json => {
        if (!cancelled) {
          const charges = (json.data || []).filter(
            (c: { booking_id?: string | null }) => !!c.booking_id
          );
          setOutstandingCharges(charges);
        }
      })
      .catch(() => { if (!cancelled) setOutstandingCharges([]); });
    return () => { cancelled = true; };
  }, [debouncedLeadId]);

  // Auto-detect prepaid purchase when customer + space are both selected
  // (debounced — coalesces rapid lead/space switches into a single fetch)
  useEffect(() => {
    const hasPrepaidTarget = (debouncedLeadId || debouncedGuestCompany) && debouncedSpaceId;
    if (!hasPrepaidTarget) {
      setActivePurchase(null);
      return;
    }
    let cancelled = false;
    setPrepaidChecking(true);
    const params = new URLSearchParams({ space_id: debouncedSpaceId });
    if (debouncedLeadId) params.set("lead_id", debouncedLeadId);
    if (debouncedGuestCompany) params.set("company_name", debouncedGuestCompany);
    fetch(`/api/prepaid-purchases/check?${params}`)
      .then(r => r.json())
      .then(json => {
        if (!cancelled) {
          setActivePurchase(json.data || null);
          setUsePrepaid(!!json.data); // default to true when found
        }
      })
      .catch(() => { if (!cancelled) setActivePurchase(null); })
      .finally(() => { if (!cancelled) setPrepaidChecking(false); });
    return () => { cancelled = true; };
  }, [debouncedLeadId, debouncedGuestCompany, debouncedSpaceId]);

  // Fetch contracts for dropdown (debounced customer-type + location)
  useEffect(() => {
    if (debouncedCustomerType === "contract_holder" || debouncedCustomerType === "guest") {
      const params = new URLSearchParams({ status: "active", limit: "100" });
      if (debouncedLocationId) params.set("location_id", debouncedLocationId);
      fetch(`/api/contracts?${params}`)
        .then(r => r.json())
        .then(json => setContracts(json.data || []))
        .catch(() => setContracts([]));
    }
  }, [debouncedCustomerType, debouncedLocationId]);

  // Calculate pricing
  const durationHours = (() => {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
  })();

  // Format fractional hours as "Xh Ym" (e.g. 2.75 → "2h 45m")
  const formatDuration = (hours: number): string => {
    if (hours <= 0) return "—";
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h 00m`;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  };

  const parsedCustomRate = parseFloat(customRate);
  const fallbackRate = selectedSpace
    ? (isDayPass ? Number(selectedSpace.daily_rate ?? 0) : Number(selectedSpace.hourly_rate ?? 0))
    : 0;
  const effectiveRate = selectedSpace
    ? (!isNaN(parsedCustomRate) && parsedCustomRate >= 0 ? parsedCustomRate : fallbackRate)
    : 0;
  // For day passes: charge is one flat day rate, not hours × rate.
  const roomCost = selectedSpace
    ? (isDayPass ? effectiveRate : durationHours * effectiveRate)
    : 0;
  const facilityCost = selectedSpace?.facilities
    ? selectedSpace.facilities
        .filter(f => selectedFacilities.includes(f.id) && !f.is_complimentary)
        .reduce((sum, f) => sum + f.charge_per_use, 0)
    : 0;
  const totalAmount = roomCost + facilityCost;
  const GST_RATE = 18;
  const gstAmount = parseFloat((totalAmount * GST_RATE / 100).toFixed(2));
  const totalAmountWithGst = parseFloat((totalAmount + gstAmount).toFixed(2));

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
    if (!spaceId || !bookingDate) {
      toast.error("Please select room and date");
      return;
    }
    if (!isDayPass && (!startTime || !endTime)) {
      toast.error("Please select start and end times");
      return;
    }
    if (!isDayPass && durationHours < (selectedSpace?.min_booking_minutes || 60) / 60) {
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
    if ((customerType === "walk_in" || customerType === "guest") && !leadHasIdProof && !idProofFile) {
      toast.error("Government ID proof is mandatory. Please upload the customer's ID document.");
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
        booker_gst_number: bookerGstNumber.trim().toUpperCase() || undefined,
        aggregator_booking_id: aggregatorBookingId.trim() || undefined,
        num_attendees: numAttendees ? parseInt(numAttendees, 10) : undefined,
        facility_ids: selectedFacilities,
        payment_mode: paymentMode || undefined,
        payment_reference: paymentReference.trim() || undefined,
        notes: notes.trim() || undefined,
        hourly_rate: effectiveRate,
        advance_payment: advancePayment,
        prepaid_purchase_id: (usePrepaid && activePurchase) ? activePurchase.id : undefined,
        credit_id: appliedCredit?.credit.id,
        hours_to_redeem: appliedCredit?.hours_to_redeem,
        settle_charge_ids: selectedChargeIds.size > 0 ? Array.from(selectedChargeIds) : undefined,
        send_sms: sendSms,
        send_whatsapp: sendWhatsapp,
      };

      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (res.ok) {
        const bookingId = json.data?.id;
        const createdLeadId = json.data?.lead_id;
        toast.success(`Booking ${json.data?.booking_number} created`);

        // Upload ID proof if provided
        if (idProofFile && createdLeadId && !leadHasIdProof) {
          const fd = new FormData();
          // Compress image client-side before upload
          const compressed = await compressIdProof(idProofFile);
          fd.append("file", compressed, compressed.name);
          fetch(`/api/leads/${createdLeadId}/id-proof`, { method: "POST", body: fd })
            .catch(() => toast.warning("Booking created but ID proof upload failed. Please upload from the booking page."));
        }

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

  // Compress image files client-side before upload (PDFs pass through unchanged)
  const compressIdProof = async (file: File): Promise<File> => {
    if (file.type === "application/pdf") return file;
    return new Promise<File>((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX_DIM = 1200;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) { height = Math.round((height * MAX_DIM) / width); width = MAX_DIM; }
          else { width = Math.round((width * MAX_DIM) / height); height = MAX_DIM; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob) {
            resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
          } else {
            resolve(file);
          }
        }, "image/jpeg", 0.80);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
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
    setActivePurchase(null);
    setUsePrepaid(true);
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
                      {s.name} ({s.capacity} seats, {
                        s.pricing_model === "daily"
                          ? `${formatCurrency(Number(s.daily_rate ?? 0))}/day`
                          : `${formatCurrency(s.hourly_rate)}/hr`
                      })
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Date *</Label>
              <Input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>No. of Attendees</Label>
              <Input
                type="number"
                min="1"
                placeholder={selectedSpace ? `Up to ${selectedSpace.capacity}` : "e.g. 4"}
                value={numAttendees}
                onChange={(e) => setNumAttendees(e.target.value)}
              />
              {numAttendees && selectedSpace && parseInt(numAttendees, 10) > selectedSpace.capacity && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  ⚠ Exceeds room capacity of {selectedSpace.capacity} — you can still book, but seating may be tight.
                </p>
              )}
              {numAttendees && parseInt(numAttendees, 10) >= 1 && (
                <p className="text-xs text-muted-foreground">
                  {Math.ceil(parseInt(numAttendees, 10) / 2)} WiFi voucher{Math.ceil(parseInt(numAttendees, 10) / 2) !== 1 ? "s" : ""} will be issued (1 per 2 devices)
                </p>
              )}
            </div>
          </div>

          {/* Availability — day-pass uses a capacity counter, hourly uses slot windows */}
          {spaceId && bookingDate && isDayPass && selectedSpace && (
            <div className="pt-2 rounded-lg border bg-muted/20 p-3 text-sm">
              {(() => {
                const cap = selectedSpace.capacity || 1;
                const remaining = Math.max(0, cap - dayPassUsed);
                const exhausted = remaining === 0;
                return (
                  <div className="flex items-start gap-2">
                    <div className={`mt-0.5 h-2 w-2 rounded-full ${exhausted ? "bg-red-500" : "bg-emerald-500"}`} />
                    <div>
                      <div className="font-medium">
                        {exhausted ? "All day passes booked" : `${remaining} of ${cap} day passes available`} for this date
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Day passes don&apos;t use the slot grid — any seat at this location works.
                        Hourly meeting/conference rooms are unaffected.
                      </p>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          {spaceId && bookingDate && !isDayPass && (
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
                      const durationLabel = formatDuration(windowDuration / 60);

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
                    Min booking: {minBookingMin} min, then 15-min increments. Click a window to auto-fill times.
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Time Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            2. {isDayPass ? "Day Pass Coverage" : "Select Time"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isDayPass ? (
            // Day-pass: times are fixed to the centre's operating hours.
            // We still display them so the staff knows the working window,
            // but they can't be edited and they don't affect the price.
            <div className="rounded-lg border bg-muted/20 p-3 flex items-start gap-3">
              <Clock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="text-sm space-y-0.5">
                <div>
                  Day pass covers the centre&apos;s operating hours
                  {startTime && endTime
                    ? <> — <span className="font-medium">{formatTime12(startTime)} to {formatTime12(endTime)}</span></>
                    : null}
                  .
                </div>
                <p className="text-xs text-muted-foreground">
                  The customer is charged a flat day rate. Extras (extended time, printer, F&amp;B) can be added at check-out.
                </p>
              </div>
            </div>
          ) : (
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
                  <span className="text-sm font-medium">{formatDuration(durationHours)}</span>
                </div>
              </div>
            </div>
          )}

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
              <div className="space-y-2 sm:col-span-2">
                <Label>GST Number <span className="text-muted-foreground font-normal text-xs">(Optional — for tax invoice)</span></Label>
                <Input
                  value={bookerGstNumber}
                  onChange={(e) => {
                    const val = e.target.value.toUpperCase();
                    setBookerGstNumber(val);
                    if (val && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(val)) {
                      setGstError("Format: 33AAAAA0000A1Z5 (15 characters)");
                    } else {
                      setGstError(null);
                    }
                  }}
                  placeholder="e.g. 33AAAAA0000A1Z5"
                  maxLength={15}
                  className={gstError ? "border-red-400" : ""}
                />
                {gstError && <p className="text-xs text-red-500">{gstError}</p>}
                {!gstError && bookerGstNumber.length === 15 && <p className="text-xs text-green-600">✓ Valid GST format</p>}
              </div>
              {/* ID Proof — mandatory */}
              <div className="sm:col-span-2 space-y-1.5">
                <Label>Government ID Proof <span className="text-red-500">*</span> <span className="text-muted-foreground font-normal text-xs">(Aadhaar, PAN, Passport, DL)</span></Label>
                {idProofLookingUp ? (
                  <p className="text-xs text-muted-foreground">Checking ID records…</p>
                ) : leadHasIdProof ? (
                  <p className="text-xs text-green-600 font-medium">✓ ID on file — no re-upload needed</p>
                ) : (
                  <>
                    <Input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      onChange={(e) => setIdProofFile(e.target.files?.[0] || null)}
                      className="cursor-pointer"
                    />
                    <p className="text-xs text-muted-foreground">JPG, PNG, WebP, or PDF · Max 2 MB · Images auto-compressed</p>
                    {idProofFile && <p className="text-xs text-green-600">✓ {idProofFile.name} selected</p>}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Walk-in with selected customer — show read-only + ID proof status */}
          {customerType === "walk_in" && selectedCustomer && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Customer details loaded from {selectedCustomer.type === "lead" ? "lead" : "past booking"} record.</p>
              {idProofLookingUp ? (
                <p className="text-xs text-muted-foreground">Checking ID records…</p>
              ) : leadHasIdProof ? (
                <p className="text-xs text-green-600 font-medium">✓ ID on file — no re-upload needed</p>
              ) : (
                <div className="space-y-1.5">
                  <Label>Government ID Proof <span className="text-red-500">*</span></Label>
                  <Input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) => setIdProofFile(e.target.files?.[0] || null)}
                    className="cursor-pointer"
                  />
                  <p className="text-xs text-muted-foreground">JPG, PNG, WebP, or PDF · Max 2 MB · Images auto-compressed</p>
                  {idProofFile && <p className="text-xs text-green-600">✓ {idProofFile.name} selected</p>}
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
                <div className="space-y-2 sm:col-span-2">
                  <Label>GST Number <span className="text-muted-foreground font-normal text-xs">(Optional — for tax invoice)</span></Label>
                  <Input
                    value={bookerGstNumber}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase();
                      setBookerGstNumber(val);
                      if (val && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(val)) {
                        setGstError("Format: 33AAAAA0000A1Z5 (15 characters)");
                      } else {
                        setGstError(null);
                      }
                    }}
                    placeholder="e.g. 33AAAAA0000A1Z5"
                    maxLength={15}
                    className={gstError ? "border-red-400" : ""}
                  />
                  {gstError && <p className="text-xs text-red-500">{gstError}</p>}
                  {!gstError && bookerGstNumber.length === 15 && <p className="text-xs text-green-600">✓ Valid GST format</p>}
                </div>
                {/* ID Proof — mandatory for guest */}
                <div className="sm:col-span-2 space-y-1.5">
                  <Label>Government ID Proof <span className="text-red-500">*</span> <span className="text-muted-foreground font-normal text-xs">(Aadhaar, PAN, Passport, DL)</span></Label>
                  {idProofLookingUp ? (
                    <p className="text-xs text-muted-foreground">Checking ID records…</p>
                  ) : leadHasIdProof ? (
                    <p className="text-xs text-green-600 font-medium">✓ ID on file — no re-upload needed</p>
                  ) : (
                    <>
                      <Input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        onChange={(e) => setIdProofFile(e.target.files?.[0] || null)}
                        className="cursor-pointer"
                      />
                      <p className="text-xs text-muted-foreground">JPG, PNG, WebP, or PDF · Max 2 MB · Images auto-compressed</p>
                      {idProofFile && <p className="text-xs text-green-600">✓ {idProofFile.name} selected</p>}
                    </>
                  )}
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

      {/* Prepaid Package Banner — auto-detected when customer + space are selected */}
      {prepaidChecking && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <TicketCheck className="h-3.5 w-3.5" />
          Checking for active packages...
        </div>
      )}
      {!prepaidChecking && activePurchase && (
        <PrepaidBanner
          purchase={activePurchase}
          usePrepaid={usePrepaid}
          onToggle={setUsePrepaid}
          durationHours={durationHours}
          effectiveRate={effectiveRate}
        />
      )}

      {/* Lead-caution banner — fires when the resolved lead has any
          active cautions (suspected-fake-booking flags from previous
          cancellations, repeat-no-show notes, etc.). Danger-severity
          cautions block submission until explicitly acknowledged. */}
      {leadId && (
        <LeadCautionsBanner
          leadId={leadId}
          mode="booking-gate"
          onAcknowledgementChange={setAllDangerCautionsAcked}
        />
      )}

      {/* Partial-checkout credit banner — appears only when this customer
          has an active credit at THIS centre. Independent of prepaid
          packs (different mechanism, different ledger). */}
      <BookingCreditBanner
        bookerPhone={bookerPhone}
        locationId={locationId}
        durationHours={durationHours}
        applied={appliedCredit}
        onApply={(credit, hours) => setAppliedCredit({ credit, hours_to_redeem: hours })}
        onClear={() => setAppliedCredit(null)}
      />

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
                    setAdvancePaymentAmount(totalAmountWithGst > 0 ? totalAmountWithGst.toFixed(2) : "");
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
                      placeholder={`Total incl. GST: ${formatCurrency(totalAmountWithGst)}`}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Payment Method</Label>
                    <div className="flex gap-1.5 flex-wrap">
                      {[
                        { mode: "cash", icon: Banknote, label: "Cash" },
                        { mode: "card", icon: CreditCard, label: "Card" },
                        { mode: "upi", icon: Smartphone, label: "UPI" },
                        ...(razorpayEnabled ? [{ mode: "send_link", icon: Link2, label: "Send Link" }] : []),
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
          <div className="space-y-1.5 pt-1">
            <Label className="text-sm">Aggregator Booking ID <span className="text-muted-foreground font-normal text-xs">(Optional — if referred by an aggregator)</span></Label>
            <Input
              value={aggregatorBookingId}
              onChange={(e) => setAggregatorBookingId(e.target.value)}
              placeholder="e.g. AGG-12345"
            />
          </div>
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

      {/* Outstanding Charges — Interactive Collection */}
      {outstandingCharges.length > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-2">
                <p className="font-semibold text-amber-800">
                  Past dues: ₹{outstandingCharges.reduce((s, c) => s + c.total, 0).toLocaleString("en-IN")}
                </p>
                {selectedChargeIds.size > 0 && (
                  <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded">
                    +₹{outstandingCharges.filter(c => selectedChargeIds.has(c.id)).reduce((s, c) => s + c.total, 0).toLocaleString("en-IN")} added to bill
                  </span>
                )}
              </div>
              <p className="text-sm text-amber-700 mb-2">
                Select charges to include in this booking&apos;s payment.
              </p>
              <div className="space-y-1">
                {outstandingCharges.map((c) => (
                  <div key={c.id}>
                    <div
                      className={`flex items-center gap-2 text-sm rounded px-3 py-2 border cursor-pointer transition-colors ${
                        selectedChargeIds.has(c.id) ? "bg-green-50 border-green-300" : "bg-white/70 border-amber-100 hover:border-amber-200"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedChargeIds.has(c.id)}
                        onChange={() => {
                          setSelectedChargeIds(prev => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                            return next;
                          });
                        }}
                        className="h-4 w-4 rounded border-amber-300"
                      />
                      <button
                        type="button"
                        className="flex-1 flex items-center justify-between text-left"
                        onClick={() => setExpandedChargeId(expandedChargeId === c.id ? null : c.id)}
                      >
                        <span className={selectedChargeIds.has(c.id) ? "text-green-900" : "text-amber-900"}>{c.description}</span>
                        <span className="font-semibold text-amber-800 ml-4 shrink-0">₹{c.total.toLocaleString("en-IN")}</span>
                      </button>
                    </div>
                    {expandedChargeId === c.id && (
                      <div className="ml-8 mt-1 mb-2 p-3 bg-white rounded border border-amber-100 text-xs space-y-1">
                        {c.booking && <p><span className="text-muted-foreground">From:</span> {c.booking.booking_number} ({c.booking.booking_date})</p>}
                        {c.charge_date && <p><span className="text-muted-foreground">Charged:</span> {c.charge_date}</p>}
                        {c.quantity && c.unit_price ? <p><span className="text-muted-foreground">Breakdown:</span> {c.quantity} × ₹{c.unit_price.toLocaleString("en-IN")} = ₹{c.total.toLocaleString("en-IN")}</p> : null}
                        {c.notes && <p><span className="text-muted-foreground">Reason:</span> {c.notes}</p>}
                        {c.proof_path && <p><a href={`/api/documents/view?path=${encodeURIComponent(c.proof_path)}`} target="_blank" rel="noopener noreferrer" className="text-primary underline">View Proof Photo</a></p>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

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
              <p className="text-xs text-muted-foreground">{isDayPass ? "Coverage" : "Duration"}</p>
              <p className="font-medium text-sm">{isDayPass ? "1 Day" : formatDuration(durationHours)}</p>
            </div>
          </div>
          <div className="border-t pt-3 space-y-1">
            {selectedSpace && (
              <div className="flex justify-between text-sm items-center">
                <span className="text-muted-foreground">{isDayPass ? "Day Rate" : "Hourly Rate"}</span>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-xs">₹</span>
                  <Input
                    type="number" min="0" step="0.01"
                    value={customRate}
                    onChange={(e) => setCustomRate(e.target.value)}
                    className="h-6 w-20 text-right text-xs px-1"
                  />
                  <span className="text-muted-foreground text-xs">{isDayPass ? "/day" : "/hr"}</span>
                </div>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{isDayPass ? "Day Pass (1 day)" : `Room (${formatDuration(durationHours)})`}</span>
              <span>{formatCurrency(roomCost)}</span>
            </div>
            {facilityCost > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Facilities</span>
                <span>{formatCurrency(facilityCost)}</span>
              </div>
            )}
            {/* GST row */}
            {totalAmount > 0 && (
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>GST ({GST_RATE}%)</span>
                <span>{formatCurrency(gstAmount)}</span>
              </div>
            )}
            {/* Gap 3: Prepaid-aware pricing rows */}
            {usePrepaid && activePurchase && (() => {
              const purchase = activePurchase;
              const creditType = purchase.credit_type;
              let coveredAmount = 0;
              let coverageLabel = "";
              if (creditType === "bookings" || creditType === "days") {
                coveredAmount = roomCost;
                coverageLabel = "Package applied";
              } else {
                const coveredHours = Math.min(purchase.credits_remaining, durationHours);
                coveredAmount = coveredHours * effectiveRate;
                coverageLabel = coveredHours < durationHours
                  ? `Package covers (${coveredHours}h)`
                  : "Package applied";
              }
              const topUpDue = Math.max(0, totalAmountWithGst - coveredAmount);
              return (
                <>
                  <div className="flex justify-between text-sm text-green-700">
                    <span className="flex items-center gap-1">
                      <TicketCheck className="h-3.5 w-3.5" />
                      {coverageLabel}
                    </span>
                    <span>− {formatCurrency(coveredAmount)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-base pt-1 border-t">
                    <span>{topUpDue > 0 ? "Top-up due (incl. GST)" : "Total due"}</span>
                    <span className="flex items-center gap-1">
                      <IndianRupee className="h-4 w-4" />
                      {formatCurrency(topUpDue)}
                    </span>
                  </div>
                </>
              );
            })()}
            {/* Past dues added to this bill */}
            {selectedChargeIds.size > 0 && (
              <>
                {outstandingCharges.filter(c => selectedChargeIds.has(c.id)).map(c => (
                  <div key={c.id} className="flex justify-between text-sm text-amber-700">
                    <span className="truncate max-w-[200px]">+ {c.description}</span>
                    <span>{formatCurrency(c.total)}</span>
                  </div>
                ))}
              </>
            )}
            {!(usePrepaid && activePurchase) && (
              <div className="flex justify-between font-bold text-base pt-1 border-t">
                <span>Total (incl. GST)</span>
                <span className="flex items-center gap-1">
                  <IndianRupee className="h-4 w-4" />
                  {formatCurrency(totalAmountWithGst + outstandingCharges.filter(c => selectedChargeIds.has(c.id)).reduce((s, c) => s + c.total, 0))}
                </span>
              </div>
            )}
          </div>

          {/* Notification preferences */}
          <div className="flex items-center gap-4 mt-3 pt-3 border-t">
            <span className="text-xs text-muted-foreground">Notify customer:</span>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={sendSms} onChange={(e) => setSendSms(e.target.checked)} className="h-3.5 w-3.5 rounded" />
              <span>SMS</span>
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-not-allowed opacity-50" title="WhatsApp setup not yet complete">
              <input type="checkbox" checked={sendWhatsapp} disabled className="h-3.5 w-3.5 rounded" />
              <span>WhatsApp</span>
            </label>
          </div>

          <Button
            className="w-full mt-3"
            size="lg"
            onClick={handleSubmit}
            disabled={saving || !spaceId || !startTime || !endTime || durationHours <= 0 || !bookerPhone.trim() || !allDangerCautionsAcked}
          >
            {saving ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating Booking...</>
            ) : (usePrepaid && activePurchase) ? (
              "Confirm & Apply Package"
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

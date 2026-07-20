"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, TicketCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDebounced } from "@/hooks/use-debounced";
import { toast } from "sonner";
import type { Space, PrepaidPurchase } from "@/types";
import { CustomerHistoryCard } from "@/components/bookings/customer-history-card";
import { PrepaidBanner } from "@/components/packages/prepaid-banner";
import { BookingCreditBanner } from "@/components/bookings/booking-credit-banner";
import { LeadCautionsBanner } from "@/components/leads/lead-cautions-banner";
import type { BookingCredit, BookingComplimentaryReason } from "@/types";
import { WaitlistDialog } from "@/components/bookings/waitlist-dialog";
import { CreateRecurringDialog } from "@/components/bookings/create-recurring-dialog";
import { ContractQuotaBanner } from "@/components/bookings/new-booking/contract-quota-banner";
import {
  BookingFormProvider,
  RoomSelectionSection,
  TimeSelectionSection,
  CustomerDetailsSection,
  FacilitiesSection,
  PaymentSection,
  OutstandingChargesSection,
  BookingSummarySection,
} from "@/components/bookings/new-booking";
import type { CustomerSuggestion, ContractOption, AvailableSlot, OutstandingCharge, AppliedCredit } from "@/components/bookings/new-booking";

function NewBookingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedSpaceId      = searchParams.get("space_id")      || "";
  const preselectedCustomerType = searchParams.get("customer_type") || "";
  const preselectedLeadId       = searchParams.get("lead_id")       || "";
  const preselectedBookerPhone  = searchParams.get("booker_phone")  || "";
  const preselectedContractId   = searchParams.get("contract_id")   || "";

  const [saving, setSaving] = useState(false);
  const [sendSms, setSendSms] = useState(true);
  const [sendWhatsapp, setSendWhatsapp] = useState(true);

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

  // Step 3: Customer
  const [bookerPhone, setBookerPhone] = useState(preselectedBookerPhone);
  const [customerSearchQuery, setCustomerSearchQuery] = useState("");
  const [customerSuggestions, setCustomerSuggestions] = useState<CustomerSuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const [customerType, setCustomerType] = useState<"contract_holder" | "walk_in">(
    preselectedCustomerType === "contract_holder" ? "contract_holder" : "walk_in"
  );
  const [contractId, setContractId] = useState(preselectedContractId);
  const [leadId, setLeadId] = useState(preselectedLeadId);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestCompany, setGuestCompany] = useState("");
  const [bookerGstNumber, setBookerGstNumber] = useState("");
  const [gstError, setGstError] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSuggestion | null>(null);

  const [numAttendees, setNumAttendees] = useState<string>("");
  const [numSeats, setNumSeats] = useState<number>(1);

  const [idProofFile, setIdProofFile] = useState<File | null>(null);
  const [leadHasIdProof, setLeadHasIdProof] = useState(false);
  const [idProofLookingUp, setIdProofLookingUp] = useState(false);

  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [outstandingCharges, setOutstandingCharges] = useState<OutstandingCharge[]>([]);
  const [selectedChargeIds, setSelectedChargeIds] = useState<Set<string>>(new Set());
  const [expandedChargeId, setExpandedChargeId] = useState<string | null>(null);

  // Step 4: Facilities
  const [selectedFacilities, setSelectedFacilities] = useState<string[]>([]);

  // Step 5: Payment & Notes
  const [paymentMode, setPaymentMode] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");
  const [aggregatorBookingId, setAggregatorBookingId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [loiNumber, setLoiNumber] = useState("");
  const [accessProvidedBy, setAccessProvidedBy] = useState("");
  const [collectAdvancePayment, setCollectAdvancePayment] = useState(false);
  const [advancePaymentMode, setAdvancePaymentMode] = useState<string>("cash");
  const [advancePaymentReference, setAdvancePaymentReference] = useState("");
  const [advancePaymentAmount, setAdvancePaymentAmount] = useState("");
  const [razorpayEnabled, setRazorpayEnabled] = useState(false);

  // Recurring
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringDialogOpen, setRecurringDialogOpen] = useState(false);

  // Prepaid
  const [activePurchase, setActivePurchase] = useState<PrepaidPurchase | null>(null);
  const [usePrepaid, setUsePrepaid] = useState(true);
  const [prepaidChecking, setPrepaidChecking] = useState(false);

  // Credit
  const [appliedCredit, setAppliedCredit] = useState<AppliedCredit | null>(null);

  useEffect(() => { setAppliedCredit(null); }, [bookerPhone, locationId]);

  // Complimentary
  const [complimentaryReason, setComplimentaryReason] = useState<BookingComplimentaryReason | "">("");
  const [complimentaryDetails, setComplimentaryDetails] = useState("");

  // Cautions
  const [allDangerCautionsAcked, setAllDangerCautionsAcked] = useState(true);
  useEffect(() => { setAllDangerCautionsAcked(true); }, [leadId]);

  // Waitlist
  const [waitlistDialogOpen, setWaitlistDialogOpen] = useState(false);
  const [slotConflict, setSlotConflict] = useState(false);

  // Day-pass
  const [dayPassUsed, setDayPassUsed] = useState(0);

  // Debounced selectors
  const debouncedLeadId        = useDebounced(leadId, 250);
  const debouncedSpaceId       = useDebounced(spaceId, 250);
  const debouncedBookingDate   = useDebounced(bookingDate, 250);
  const debouncedLocationId    = useDebounced(locationId, 250);
  const debouncedGuestCompany  = useDebounced(guestCompany, 350);
  const debouncedCustomerType  = useDebounced(customerType, 250);

  // ── Derived values ──────────────────────────────────────────────────────────
  const isDayPass = selectedSpace?.pricing_model === "daily";

  const durationHours = useMemo(() => {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
  }, [startTime, endTime]);

  const formatDuration = useCallback((hours: number): string => {
    if (hours <= 0) return "—";
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h 00m`;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }, []);

  const parsedCustomRate = parseFloat(customRate);
  const fallbackRate = selectedSpace
    ? (isDayPass ? Number(selectedSpace.daily_rate ?? 0) : Number(selectedSpace.hourly_rate ?? 0))
    : 0;
  const effectiveRate = selectedSpace
    ? (!isNaN(parsedCustomRate) && parsedCustomRate >= 0 ? parsedCustomRate : fallbackRate)
    : 0;
  const roomCost = selectedSpace
    ? (isDayPass ? effectiveRate * numSeats : durationHours * effectiveRate)
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

  // Conference/meeting rooms get a customer-type-aware minimum and a 30-min slot grid;
  // every other space keeps the single min_booking_minutes value on the existing 15-min grid.
  const isConferenceOrMeetingRoom = selectedSpace?.workspace_type === "conference_room" || selectedSpace?.workspace_type === "meeting_room";
  const minBookingMin = isConferenceOrMeetingRoom && customerType === "contract_holder"
    ? (selectedSpace?.min_booking_minutes_contract || 30)
    : (selectedSpace?.min_booking_minutes || 60);
  const slotStepMin = isConferenceOrMeetingRoom ? 30 : 15;

  const timeOptions = useMemo(() => {
    const times = new Set<string>();
    availableSlots.forEach(slot => { times.add(slot.start_time); times.add(slot.end_time); });
    const sorted = Array.from(times).sort();
    if (slotStepMin <= 15) return sorted;
    return sorted.filter(t => {
      const [, m] = t.split(":").map(Number);
      return m % slotStepMin === 0;
    });
  }, [availableSlots, slotStepMin]);

  const endTimeOptions = useMemo(() => {
    if (!startTime) return [];
    const [sh, sm] = startTime.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const minEndMin = startMin + minBookingMin;
    return timeOptions.filter(t => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m >= minEndMin;
    });
  }, [startTime, timeOptions, minBookingMin]);

  const availabilityWindows = useMemo(() => {
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
  }, [availableSlots]);

  const formatTime12 = useCallback((t: string) => {
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }, []);

  // ── Customer search ─────────────────────────────────────────────────────────
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

  const handleSearchInput = useCallback((val: string) => {
    setCustomerSearchQuery(val);
    if (/^[\d+\s()-]+$/.test(val)) setBookerPhone(val.replace(/\s/g, ""));
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => searchCustomers(val), 300);
  }, [searchCustomers]);

  const selectCustomerSuggestion = useCallback((sug: CustomerSuggestion) => {
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
      setCustomerType("walk_in");
      setLeadId("");
      setContractId("");
      setGuestName(sug.name);
      setGuestEmail(sug.email || "");
      setGuestPhone(sug.phone || "");
      setGuestCompany(sug.company || "");
    }
  }, []);

  const clearCustomerSelection = useCallback(() => {
    setSelectedCustomer(null);
    setCustomerSearchQuery("");
    setBookerPhone("");
    setCustomerType("walk_in");
    setContractId(""); setLeadId(""); setGuestName(""); setGuestEmail(""); setGuestPhone(""); setGuestCompany("");
    setActivePurchase(null);
    setUsePrepaid(true);
  }, []);

  // ── Effects ─────────────────────────────────────────────────────────────────

  // Razorpay setting
  useEffect(() => {
    fetch("/api/settings/public").then(r => r.json()).then(json => {
      if (json.data?.razorpay_enabled === "true") setRazorpayEnabled(true);
    }).catch(() => {});
  }, []);

  // ID proof check
  useEffect(() => {
    const phone = bookerPhone.replace(/\s/g, "");
    if (phone.length < 10 || customerType !== "walk_in") {
      setLeadHasIdProof(false);
      return;
    }
    const checkLeadId = leadId;
    if (!checkLeadId) {
      setIdProofLookingUp(true);
      fetch(`/api/leads?phone_exact=${encodeURIComponent(phone)}`)
        .then(r => r.json())
        .then(json => { const lead = (json.data || [])[0]; setLeadHasIdProof(!!(lead?.id_proof_path)); })
        .catch(() => setLeadHasIdProof(false))
        .finally(() => setIdProofLookingUp(false));
    } else {
      setIdProofLookingUp(true);
      fetch(`/api/leads/${checkLeadId}`)
        .then(r => r.json())
        .then(json => setLeadHasIdProof(!!(json.data?.id_proof_path)))
        .catch(() => setLeadHasIdProof(false))
        .finally(() => setIdProofLookingUp(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookerPhone, leadId, customerType]);

  // If the customer type changes after a time slot was picked and the slot no longer
  // meets the (possibly stricter) minimum for the new type, clear it and explain why.
  useEffect(() => {
    if (!startTime || !endTime) return;
    if (durationHours < minBookingMin / 60) {
      setEndTime("");
      toast.error(`Minimum booking is ${minBookingMin} minutes for ${customerType === "contract_holder" ? "contract holders" : "walk-in customers"} on this room — please reselect the end time.`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minBookingMin]);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) setShowSuggestions(false);
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

  // Preselected space
  useEffect(() => {
    if (preselectedSpaceId) {
      fetch(`/api/spaces/${preselectedSpaceId}`)
        .then(r => r.json())
        .then(json => {
          if (json.data) { setSelectedSpace(json.data); setLocationId(json.data.location_id); setSpaceId(json.data.id); }
        })
        .catch(() => {});
    }
  }, [preselectedSpaceId]);

  // Space details
  useEffect(() => {
    if (!spaceId) { setSelectedSpace(null); return; }
    const found = spaces.find(s => s.id === spaceId);
    if (found) { setSelectedSpace(found); }
    else if (spaceId && !preselectedSpaceId) {
      fetch(`/api/spaces/${spaceId}`)
        .then(r => r.json())
        .then(json => setSelectedSpace(json.data || null))
        .catch(() => setSelectedSpace(null));
    }
  }, [spaceId, spaces, preselectedSpaceId]);

  // Sync rate on space change
  useEffect(() => {
    if (!selectedSpace) { setCustomRate(""); return; }
    const rate = isDayPass ? Number(selectedSpace.daily_rate ?? 0) : Number(selectedSpace.hourly_rate ?? 0);
    setCustomRate(rate.toFixed(2));
    setNumSeats(1);
  }, [selectedSpace, isDayPass]);

  // Day-pass operating hours
  useEffect(() => {
    if (!isDayPass || !selectedSpace || !bookingDate) return;
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const dayKey = days[new Date(bookingDate + "T00:00:00").getDay()];
    const hours = selectedSpace.operating_hours?.[dayKey];
    if (hours?.is_open) { setStartTime(hours.open); setEndTime(hours.close); }
  }, [isDayPass, selectedSpace, bookingDate]);

  // Availability
  const fetchAvailability = useCallback(async () => {
    if (!debouncedSpaceId || !debouncedBookingDate) return;
    if (isDayPass) { setAvailableSlots([]); setSlotConflict(false); return; }
    setAvailLoading(true);
    setSlotConflict(false);
    try {
      const res = await fetch(`/api/spaces/${debouncedSpaceId}/availability?date=${debouncedBookingDate}`);
      if (res.ok) { const json = await res.json(); setAvailableSlots(json.data?.available_slots || []); }
    } catch { /* ignore */ }
    setAvailLoading(false);
  }, [debouncedSpaceId, debouncedBookingDate, isDayPass]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  // Day-pass capacity
  useEffect(() => {
    if (!isDayPass || !debouncedSpaceId || !debouncedBookingDate) { setDayPassUsed(0); return; }
    let cancelled = false;
    fetch(`/api/bookings?space_id=${debouncedSpaceId}&date_from=${debouncedBookingDate}&date_to=${debouncedBookingDate}&limit=200`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        const rows = (j.data || []) as Array<{ status: string }>;
        setDayPassUsed(rows.filter(b => ["confirmed", "checked_in", "checked_out"].includes(b.status)).length);
      })
      .catch(() => { if (!cancelled) setDayPassUsed(0); });
    return () => { cancelled = true; };
  }, [isDayPass, debouncedSpaceId, debouncedBookingDate]);

  // Slot conflict check
  useEffect(() => {
    if (!startTime || !endTime || !spaceId || !bookingDate) { setSlotConflict(false); return; }
    const isAvailable = availabilityWindows.some(w => startTime >= w.start_time && endTime <= w.end_time);
    setSlotConflict(!isAvailable && availableSlots.length > 0);
  }, [startTime, endTime, availabilityWindows, availableSlots, spaceId, bookingDate]);

  // Outstanding charges
  useEffect(() => {
    if (!debouncedLeadId) { setOutstandingCharges([]); return; }
    let cancelled = false;
    fetch(`/api/usage-charges?lead_id=${debouncedLeadId}&status=pending&limit=50`)
      .then(r => r.json())
      .then(json => {
        if (!cancelled) {
          setOutstandingCharges((json.data || []).filter((c: { booking_id?: string | null }) => !!c.booking_id));
        }
      })
      .catch(() => { if (!cancelled) setOutstandingCharges([]); });
    return () => { cancelled = true; };
  }, [debouncedLeadId]);

  // Prepaid auto-detect
  useEffect(() => {
    const hasPrepaidTarget = (debouncedLeadId || debouncedGuestCompany) && debouncedSpaceId;
    if (!hasPrepaidTarget) { setActivePurchase(null); return; }
    let cancelled = false;
    setPrepaidChecking(true);
    const params = new URLSearchParams({ space_id: debouncedSpaceId });
    if (debouncedLeadId) params.set("lead_id", debouncedLeadId);
    if (debouncedGuestCompany) params.set("company_name", debouncedGuestCompany);
    fetch(`/api/prepaid-purchases/check?${params}`)
      .then(r => r.json())
      .then(json => {
        if (!cancelled) { setActivePurchase(json.data || null); setUsePrepaid(!!json.data); }
      })
      .catch(() => { if (!cancelled) setActivePurchase(null); })
      .finally(() => { if (!cancelled) setPrepaidChecking(false); });
    return () => { cancelled = true; };
  }, [debouncedLeadId, debouncedGuestCompany, debouncedSpaceId]);

  // Contracts
  useEffect(() => {
    if (debouncedCustomerType === "contract_holder") {
      const params = new URLSearchParams({ status: "active,renewal_in_progress", limit: "100" });
      if (debouncedLocationId) params.set("location_id", debouncedLocationId);
      fetch(`/api/contracts?${params}`)
        .then(r => r.json())
        .then(json => setContracts(json.data || []))
        .catch(() => setContracts([]));
    }
  }, [debouncedCustomerType, debouncedLocationId]);

  // ── Image compression ───────────────────────────────────────────────────────
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
          if (blob) resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
          else resolve(file);
        }, "image/jpeg", 0.80);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!bookerPhone.trim()) { toast.error("Mobile number is mandatory"); return; }
    if (!spaceId || !bookingDate) { toast.error("Please select room and date"); return; }
    if (!isDayPass && (!startTime || !endTime)) { toast.error("Please select start and end times"); return; }
    if (!isDayPass && durationHours < minBookingMin / 60) {
      toast.error(`Minimum booking is ${minBookingMin} minutes`); return;
    }
    if (totalAmountWithGst <= 0) {
      if (!complimentaryReason) { toast.error("Pick a reason for this complimentary booking"); return; }
      if (complimentaryReason === "other" && !complimentaryDetails.trim()) { toast.error('Add details — "Other" requires a reason'); return; }
    }
    if (customerType === "contract_holder" && !contractId) { toast.error("Please select a contract"); return; }
    if (customerType === "walk_in" && !leadId && !guestName.trim()) { toast.error("Please select a lead or enter guest details"); return; }
    if (customerType === "walk_in" && !leadHasIdProof && !idProofFile) {
      toast.error("Government ID proof is mandatory. Please upload the customer's ID document."); return;
    }

    setSaving(true);
    try {
      let advancePayment: { amount: number; payment_mode: string; payment_reference?: string } | undefined;
      if (collectAdvancePayment && customerType === "walk_in") {
        const advAmt = parseFloat(advancePaymentAmount);
        if (advAmt > 0 && (advancePaymentMode === "cash" || advancePaymentMode === "card")) {
          advancePayment = { amount: advAmt, payment_mode: advancePaymentMode, payment_reference: advancePaymentReference.trim() || undefined };
        }
      }

      const payload = {
        space_id: spaceId, booking_date: bookingDate, start_time: startTime, end_time: endTime,
        customer_type: customerType, contract_id: contractId || undefined, lead_id: leadId || undefined,
        booker_phone: bookerPhone.trim(), guest_name: guestName.trim() || undefined,
        guest_email: guestEmail.trim() || undefined, guest_phone: guestPhone.trim() || undefined,
        guest_company: guestCompany.trim() || undefined, booker_gst_number: bookerGstNumber.trim().toUpperCase() || undefined,
        aggregator_booking_id: aggregatorBookingId.trim() || undefined,
        purpose: purpose.trim() || undefined,
        loi_number: loiNumber.trim() || undefined,
        access_provided_by: accessProvidedBy.trim() || undefined,
        num_attendees: numAttendees ? parseInt(numAttendees, 10) : undefined,
        num_seats: isDayPass ? numSeats : undefined,
        facility_ids: selectedFacilities, payment_mode: paymentMode || undefined,
        payment_reference: paymentReference.trim() || undefined, notes: notes.trim() || undefined,
        hourly_rate: effectiveRate, advance_payment: advancePayment,
        prepaid_purchase_id: (usePrepaid && activePurchase) ? activePurchase.id : undefined,
        credit_id: appliedCredit?.credit.id, hours_to_redeem: appliedCredit?.hours_to_redeem,
        complimentary_reason: totalAmountWithGst <= 0 ? complimentaryReason : undefined,
        complimentary_details: totalAmountWithGst <= 0 ? (complimentaryDetails.trim() || undefined) : undefined,
        settle_charge_ids: selectedChargeIds.size > 0 ? Array.from(selectedChargeIds) : undefined,
        send_sms: sendSms, send_whatsapp: sendWhatsapp,
      };

      const res = await fetch("/api/bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (res.ok) {
        const bookingId = json.data?.id;
        const createdLeadId = json.data?.lead_id;
        toast.success(`Booking ${json.data?.booking_number} created`);

        if (idProofFile && createdLeadId && !leadHasIdProof) {
          const fd = new FormData();
          const compressed = await compressIdProof(idProofFile);
          fd.append("file", compressed, compressed.name);
          fetch(`/api/leads/${createdLeadId}/id-proof`, { method: "POST", body: fd })
            .catch(() => toast.warning("Booking created but ID proof upload failed. Please upload from the booking page."));
        }
        if (bookingId) {
          fetch(`/api/bookings/${bookingId}/email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "confirmation" }) }).catch(() => {});
        }
        if (collectAdvancePayment && advancePaymentMode === "send_link" && bookingId) {
          fetch("/api/payments/create-payment-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ booking_id: bookingId }) })
            .then(r => r.json())
            .then(json => { if (json.data?.payment_link_url) toast.success("Payment link sent to customer via SMS & email"); else toast.error(json.error || "Failed to send payment link"); })
            .catch(() => toast.error("Failed to send payment link"));
        }
        if (collectAdvancePayment && (advancePaymentMode === "upi" || advancePaymentMode === "razorpay")) {
          toast.info("Redirecting to booking page to complete payment...");
          router.push(bookingId ? `/bookings/${bookingId}?collect_payment=true` : "/bookings");
        } else {
          router.push(bookingId ? `/bookings/${bookingId}` : "/bookings");
        }
      } else {
        toast.error(json.error || "Failed to create booking");
      }
    } catch { toast.error("Failed to create booking"); }
    finally { setSaving(false); }
  }, [
    bookerPhone, spaceId, bookingDate, startTime, endTime, isDayPass, durationHours, minBookingMin,
    totalAmountWithGst, complimentaryReason, complimentaryDetails,
    customerType, contractId, leadId, guestName, guestEmail, guestPhone, guestCompany,
    bookerGstNumber, aggregatorBookingId, purpose, loiNumber, accessProvidedBy, numAttendees, numSeats, selectedFacilities,
    paymentMode, paymentReference, notes, effectiveRate, collectAdvancePayment,
    advancePaymentMode, advancePaymentAmount, advancePaymentReference, usePrepaid,
    activePurchase, appliedCredit, selectedChargeIds, sendSms, sendWhatsapp,
    leadHasIdProof, idProofFile, router,
  ]);

  // ── Context value ───────────────────────────────────────────────────────────
  const contextValue = useMemo(() => ({
    saving, setSaving, sendSms, setSendSms, sendWhatsapp, setSendWhatsapp,
    locationId, setLocationId, spaces, setSpaces, spaceId, setSpaceId,
    selectedSpace, setSelectedSpace, bookingDate, setBookingDate,
    availableSlots, setAvailableSlots, availLoading, setAvailLoading,
    customRate, setCustomRate, numAttendees, setNumAttendees,
    numSeats, setNumSeats, dayPassUsed, isDayPass, slotConflict, setSlotConflict,
    startTime, setStartTime, endTime, setEndTime,
    bookerPhone, setBookerPhone, customerSearchQuery, setCustomerSearchQuery,
    customerSuggestions, setCustomerSuggestions, searchLoading, setSearchLoading,
    showSuggestions, setShowSuggestions, searchTimeoutRef, suggestionsRef,
    customerType, setCustomerType, contractId, setContractId,
    leadId, setLeadId, guestName, setGuestName, guestEmail, setGuestEmail,
    guestPhone, setGuestPhone, guestCompany, setGuestCompany,
    bookerGstNumber, setBookerGstNumber, gstError, setGstError,
    selectedCustomer, setSelectedCustomer,
    idProofFile, setIdProofFile, leadHasIdProof, idProofLookingUp, contracts,
    selectedFacilities, setSelectedFacilities,
    paymentMode, setPaymentMode, paymentReference, setPaymentReference,
    notes, setNotes, aggregatorBookingId, setAggregatorBookingId,
    purpose, setPurpose, loiNumber, setLoiNumber, accessProvidedBy, setAccessProvidedBy,
    collectAdvancePayment, setCollectAdvancePayment,
    advancePaymentMode, setAdvancePaymentMode,
    advancePaymentReference, setAdvancePaymentReference,
    advancePaymentAmount, setAdvancePaymentAmount, razorpayEnabled,
    outstandingCharges, selectedChargeIds, setSelectedChargeIds,
    expandedChargeId, setExpandedChargeId,
    isRecurring, setIsRecurring, recurringDialogOpen, setRecurringDialogOpen,
    activePurchase, usePrepaid, setUsePrepaid, prepaidChecking,
    appliedCredit, setAppliedCredit,
    complimentaryReason, setComplimentaryReason,
    complimentaryDetails, setComplimentaryDetails,
    allDangerCautionsAcked, setAllDangerCautionsAcked,
    waitlistDialogOpen, setWaitlistDialogOpen,
    durationHours, effectiveRate, roomCost, facilityCost, totalAmount, gstAmount, totalAmountWithGst,
    availabilityWindows, timeOptions, endTimeOptions, minBookingMin, slotStepMin,
    handleSubmit, handleSearchInput, selectCustomerSuggestion, clearCustomerSelection,
    formatTime12, formatDuration,
  }), [
    saving, sendSms, sendWhatsapp,
    locationId, spaces, spaceId, selectedSpace, bookingDate,
    availableSlots, availLoading, customRate, numAttendees, numSeats,
    dayPassUsed, isDayPass, slotConflict,
    startTime, endTime,
    bookerPhone, customerSearchQuery, customerSuggestions, searchLoading,
    showSuggestions, customerType, contractId, leadId,
    guestName, guestEmail, guestPhone, guestCompany,
    bookerGstNumber, gstError, selectedCustomer,
    idProofFile, leadHasIdProof, idProofLookingUp, contracts,
    selectedFacilities, paymentMode, paymentReference, notes,
    aggregatorBookingId, purpose, loiNumber, accessProvidedBy, collectAdvancePayment, advancePaymentMode,
    advancePaymentReference, advancePaymentAmount, razorpayEnabled,
    outstandingCharges, selectedChargeIds, expandedChargeId,
    isRecurring, recurringDialogOpen,
    activePurchase, usePrepaid, prepaidChecking,
    appliedCredit, complimentaryReason, complimentaryDetails,
    allDangerCautionsAcked, waitlistDialogOpen,
    durationHours, effectiveRate, roomCost, facilityCost, totalAmount, gstAmount, totalAmountWithGst,
    availabilityWindows, timeOptions, endTimeOptions, minBookingMin, slotStepMin,
    handleSubmit, handleSearchInput, selectCustomerSuggestion, clearCustomerSelection,
    formatTime12, formatDuration,
  ]);

  return (
    <BookingFormProvider value={contextValue}>
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

        <RoomSelectionSection />
        <CustomerDetailsSection />
        <TimeSelectionSection />

        {/* Contract quota status — shown when booking for a contract holder */}
        {customerType === "contract_holder" && contractId && (
          <ContractQuotaBanner
            contractId={contractId}
            durationHours={durationHours}
            bookingDate={bookingDate}
          />
        )}

        {/* Customer history */}
        {bookerPhone && bookerPhone.length >= 10 && (
          <CustomerHistoryCard phone={bookerPhone} leadId={leadId || undefined} />
        )}

        {/* Prepaid package banner */}
        {prepaidChecking && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <TicketCheck className="h-3.5 w-3.5" />
            Checking for active packages...
          </div>
        )}
        {!prepaidChecking && activePurchase && (
          <PrepaidBanner
            purchase={activePurchase} usePrepaid={usePrepaid} onToggle={setUsePrepaid}
            durationHours={durationHours} effectiveRate={effectiveRate}
          />
        )}

        {/* Lead cautions */}
        {leadId && (
          <LeadCautionsBanner leadId={leadId} mode="booking-gate" onAcknowledgementChange={setAllDangerCautionsAcked} />
        )}

        {/* Credit banner */}
        <BookingCreditBanner
          bookerPhone={bookerPhone} locationId={locationId}
          durationHours={durationHours} applied={appliedCredit}
          onApply={(credit, hours) => setAppliedCredit({ credit, hours_to_redeem: hours })}
          onClear={() => setAppliedCredit(null)}
        />

        <FacilitiesSection />
        <PaymentSection />
        <OutstandingChargesSection />
        <BookingSummarySection />

        {/* Dialogs */}
        {spaceId && startTime && endTime && locationId && (
          <CreateRecurringDialog
            open={recurringDialogOpen} onOpenChange={setRecurringDialogOpen}
            prefill={{
              space_id: spaceId, customer_type: customerType, contract_id: contractId || undefined,
              lead_id: leadId || undefined, booker_phone: bookerPhone, guest_name: guestName || undefined,
              guest_email: guestEmail || undefined, guest_phone: guestPhone || undefined,
              guest_company: guestCompany || undefined, start_time: startTime, end_time: endTime,
            }}
            onCreated={() => router.push("/bookings")}
          />
        )}
        {spaceId && startTime && endTime && (
          <WaitlistDialog
            open={waitlistDialogOpen} onOpenChange={setWaitlistDialogOpen}
            spaceId={spaceId} bookingDate={bookingDate} startTime={startTime} endTime={endTime}
            customerType={customerType} contractId={contractId || undefined} leadId={leadId || undefined}
            guestName={guestName || undefined} guestPhone={guestPhone || undefined}
            bookerPhone={bookerPhone}
            onAdded={() => toast.success("Added to waitlist")}
          />
        )}
      </div>
    </BookingFormProvider>
  );
}

export default function NewBookingPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
      <NewBookingForm />
    </Suspense>
  );
}

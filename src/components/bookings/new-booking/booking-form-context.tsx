"use client";

import { createContext, useContext } from "react";
import type { Space, PrepaidPurchase } from "@/types";
import type { BookingCredit, BookingComplimentaryReason } from "@/types";

export interface CustomerSuggestion {
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

export interface ContractOption {
  id: string;
  contract_number: string;
  lead?: { id: string; first_name: string; last_name: string; company?: string; email?: string; phone?: string };
}

export interface AvailableSlot {
  start_time: string;
  end_time: string;
}

export interface OutstandingCharge {
  id: string;
  description: string;
  total: number;
  notes?: string;
  quantity?: number;
  unit_price?: number;
  charge_date?: string;
  proof_path?: string;
  booking?: { booking_number: string; booking_date: string };
}

export interface AppliedCredit {
  credit: BookingCredit & { hours_remaining: number };
  hours_to_redeem: number;
}

// Everything the child sections can read/write
export interface BookingFormState {
  // Saving
  saving: boolean;
  setSaving: (v: boolean) => void;
  sendSms: boolean;
  setSendSms: (v: boolean) => void;
  sendWhatsapp: boolean;
  setSendWhatsapp: (v: boolean) => void;

  // Room selection
  locationId: string;
  setLocationId: (v: string) => void;
  spaces: Space[];
  setSpaces: (v: Space[]) => void;
  spaceId: string;
  setSpaceId: (v: string) => void;
  selectedSpace: Space | null;
  setSelectedSpace: (v: Space | null) => void;
  bookingDate: string;
  setBookingDate: (v: string) => void;
  availableSlots: AvailableSlot[];
  setAvailableSlots: (v: AvailableSlot[]) => void;
  availLoading: boolean;
  setAvailLoading: (v: boolean) => void;
  customRate: string;
  setCustomRate: (v: string) => void;
  numAttendees: string;
  setNumAttendees: (v: string) => void;
  numSeats: number;
  setNumSeats: (v: number | ((prev: number) => number)) => void;
  dayPassUsed: number;
  isDayPass: boolean;
  slotConflict: boolean;
  setSlotConflict: (v: boolean) => void;

  // Time
  startTime: string;
  setStartTime: (v: string) => void;
  endTime: string;
  setEndTime: (v: string) => void;

  // Customer
  bookerPhone: string;
  setBookerPhone: (v: string) => void;
  customerSearchQuery: string;
  setCustomerSearchQuery: (v: string) => void;
  customerSuggestions: CustomerSuggestion[];
  setCustomerSuggestions: (v: CustomerSuggestion[]) => void;
  searchLoading: boolean;
  setSearchLoading: (v: boolean) => void;
  showSuggestions: boolean;
  setShowSuggestions: (v: boolean) => void;
  searchTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
  suggestionsRef: React.RefObject<HTMLDivElement | null>;
  customerType: "contract_holder" | "walk_in" | "guest";
  setCustomerType: (v: "contract_holder" | "walk_in" | "guest") => void;
  contractId: string;
  setContractId: (v: string) => void;
  leadId: string;
  setLeadId: (v: string) => void;
  guestName: string;
  setGuestName: (v: string) => void;
  guestEmail: string;
  setGuestEmail: (v: string) => void;
  guestPhone: string;
  setGuestPhone: (v: string) => void;
  guestCompany: string;
  setGuestCompany: (v: string) => void;
  bookerGstNumber: string;
  setBookerGstNumber: (v: string) => void;
  gstError: string | null;
  setGstError: (v: string | null) => void;
  selectedCustomer: CustomerSuggestion | null;
  setSelectedCustomer: (v: CustomerSuggestion | null) => void;
  idProofFile: File | null;
  setIdProofFile: (v: File | null) => void;
  leadHasIdProof: boolean;
  idProofLookingUp: boolean;
  contracts: ContractOption[];

  // Facilities
  selectedFacilities: string[];
  setSelectedFacilities: (v: string[] | ((prev: string[]) => string[])) => void;

  // Payment & Notes
  paymentMode: string;
  setPaymentMode: (v: string) => void;
  paymentReference: string;
  setPaymentReference: (v: string) => void;
  notes: string;
  setNotes: (v: string | ((prev: string) => string)) => void;
  aggregatorBookingId: string;
  setAggregatorBookingId: (v: string) => void;
  purpose: string;
  setPurpose: (v: string) => void;
  loiNumber: string;
  setLoiNumber: (v: string) => void;
  accessProvidedBy: string;
  setAccessProvidedBy: (v: string) => void;
  collectAdvancePayment: boolean;
  setCollectAdvancePayment: (v: boolean) => void;
  advancePaymentMode: string;
  setAdvancePaymentMode: (v: string) => void;
  advancePaymentReference: string;
  setAdvancePaymentReference: (v: string) => void;
  advancePaymentAmount: string;
  setAdvancePaymentAmount: (v: string) => void;
  razorpayEnabled: boolean;

  // Outstanding charges
  outstandingCharges: OutstandingCharge[];
  selectedChargeIds: Set<string>;
  setSelectedChargeIds: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  expandedChargeId: string | null;
  setExpandedChargeId: (v: string | null) => void;

  // Recurring
  isRecurring: boolean;
  setIsRecurring: (v: boolean) => void;
  recurringDialogOpen: boolean;
  setRecurringDialogOpen: (v: boolean) => void;

  // Prepaid
  activePurchase: PrepaidPurchase | null;
  usePrepaid: boolean;
  setUsePrepaid: (v: boolean) => void;
  prepaidChecking: boolean;

  // Credit
  appliedCredit: AppliedCredit | null;
  setAppliedCredit: (v: AppliedCredit | null) => void;

  // Complimentary
  complimentaryReason: BookingComplimentaryReason | "";
  setComplimentaryReason: (v: BookingComplimentaryReason | "") => void;
  complimentaryDetails: string;
  setComplimentaryDetails: (v: string) => void;

  // Cautions
  allDangerCautionsAcked: boolean;
  setAllDangerCautionsAcked: (v: boolean) => void;

  // Waitlist
  waitlistDialogOpen: boolean;
  setWaitlistDialogOpen: (v: boolean) => void;

  // Computed values
  durationHours: number;
  effectiveRate: number;
  roomCost: number;
  facilityCost: number;
  totalAmount: number;
  gstAmount: number;
  totalAmountWithGst: number;
  availabilityWindows: { start_time: string; end_time: string }[];
  timeOptions: string[];
  endTimeOptions: string[];
  minBookingMin: number;

  // Functions
  handleSubmit: () => Promise<void>;
  handleSearchInput: (val: string) => void;
  selectCustomerSuggestion: (sug: CustomerSuggestion) => void;
  clearCustomerSelection: () => void;
  formatTime12: (t: string) => string;
  formatDuration: (hours: number) => string;
}

const BookingFormContext = createContext<BookingFormState | null>(null);

export function BookingFormProvider({
  value,
  children,
}: {
  value: BookingFormState;
  children: React.ReactNode;
}) {
  return <BookingFormContext.Provider value={value}>{children}</BookingFormContext.Provider>;
}

export function useBookingForm(): BookingFormState {
  const ctx = useContext(BookingFormContext);
  if (!ctx) throw new Error("useBookingForm must be used within BookingFormProvider");
  return ctx;
}

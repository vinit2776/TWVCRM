"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, FileText, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";

interface Contract {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
  total_amount: number;
}

interface Booking {
  id: string;
  booking_number: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  total_amount: number;
  payment_status: string;
  status: string;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  guest_name?: string | null;
  space?: { name: string } | null;
}

type ChargeType = "contract" | "booking";

interface AddUsageChargeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  contractId?: string;
  bookingId?: string;
}

export function AddUsageChargeDialog({
  open,
  onOpenChange,
  onSuccess,
  contractId,
  bookingId,
}: AddUsageChargeDialogProps) {
  // Charge type toggle — lock to "booking" if bookingId is pre-supplied
  const [chargeType, setChargeType] = useState<ChargeType>(
    bookingId ? "booking" : "contract"
  );

  // Contract mode state
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [selectedContractId, setSelectedContractId] = useState(contractId || "");

  // Booking mode state
  const [bookingSearch, setBookingSearch] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [selectedBookingId, setSelectedBookingId] = useState(bookingId || "");
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);

  // Shared charge fields
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState<number>(1);
  const [unitPrice, setUnitPrice] = useState<number>(0);
  // GST defaults to the standard 18% — most ad-hoc charges (overtime, F&B,
  // damage) attract the same rate as the booking. Editable in case a
  // particular charge is exempt or carries a different slab (12 / 5 / 0).
  const [gstRate, setGstRate] = useState<number>(18);
  const [chargeDate, setChargeDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const subtotal = quantity * unitPrice;
  const gstAmount = parseFloat((subtotal * gstRate / 100).toFixed(2));
  const totalWithGst = parseFloat((subtotal + gstAmount).toFixed(2));

  // Fetch contracts when dialog opens in contract mode
  useEffect(() => {
    if (open && chargeType === "contract") {
      setLoadingContracts(true);
      fetch("/api/contracts?status=active&limit=100")
        .then((res) => res.json())
        .then((json) => setContracts(json.data || []))
        .catch(() => setContracts([]))
        .finally(() => setLoadingContracts(false));

      if (contractId) setSelectedContractId(contractId);
    }
  }, [open, chargeType, contractId]);

  // Debounce timer for booking search
  const bookingSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Server-side booking fetch — called on open and on search change
  const fetchBookings = useCallback(
    (search: string) => {
      if (bookingId) return; // pre-supplied; handled separately
      setLoadingBookings(true);
      const params = new URLSearchParams({
        status: "checked_out,no_show,cancelled",
        limit: "100",
        page: "1",
      });
      if (search.trim()) params.set("search", search.trim());
      fetch(`/api/bookings?${params.toString()}`)
        .then((res) => res.json())
        .then((json) => setBookings(json.data || []))
        .catch(() => setBookings([]))
        .finally(() => setLoadingBookings(false));
    },
    [bookingId]
  );

  // Fetch bookings when in booking mode
  useEffect(() => {
    if (open && chargeType === "booking") {
      if (bookingId) {
        // Pre-supplied — fetch just that one booking
        setLoadingBookings(true);
        fetch(`/api/bookings/${bookingId}`)
          .then((res) => res.json())
          .then((json) => {
            const b = json.data;
            if (b) {
              setBookings([b]);
              setSelectedBookingId(b.id);
              setSelectedBooking(b);
            }
          })
          .catch(() => {})
          .finally(() => setLoadingBookings(false));
      } else {
        // Initial load — recent past bookings (server-side)
        fetchBookings("");
      }
    }
  }, [open, chargeType, bookingId, fetchBookings]);

  // Debounced server-side search as user types
  useEffect(() => {
    if (!open || chargeType !== "booking" || bookingId) return;
    if (bookingSearchTimer.current) clearTimeout(bookingSearchTimer.current);
    bookingSearchTimer.current = setTimeout(() => {
      fetchBookings(bookingSearch);
    }, 300);
    return () => {
      if (bookingSearchTimer.current) clearTimeout(bookingSearchTimer.current);
    };
  }, [bookingSearch, open, chargeType, bookingId, fetchBookings]);

  // Sync selected booking object when ID changes
  useEffect(() => {
    if (selectedBookingId) {
      const found = bookings.find((b) => b.id === selectedBookingId) || null;
      setSelectedBooking(found);
    } else {
      setSelectedBooking(null);
    }
  }, [selectedBookingId, bookings]);

  // Search is server-side — show all loaded results
  const filteredBookings = bookings;

  const resetForm = () => {
    setChargeType(bookingId ? "booking" : "contract");
    setSelectedContractId(contractId || "");
    setSelectedBookingId(bookingId || "");
    setSelectedBooking(null);
    setBookingSearch("");
    setDescription("");
    setQuantity(1);
    setUnitPrice(0);
    setGstRate(18);
    setChargeDate(new Date().toISOString().split("T")[0]);
    setNotes("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (chargeType === "contract" && !selectedContractId) {
      toast.error("Please select a contract");
      return;
    }
    if (chargeType === "booking" && !selectedBookingId) {
      toast.error("Please select a booking");
      return;
    }
    if (!description.trim()) {
      toast.error("Please enter a description");
      return;
    }
    if (quantity <= 0) {
      toast.error("Quantity must be greater than 0");
      return;
    }
    if (unitPrice <= 0) {
      toast.error("Unit price must be greater than 0");
      return;
    }
    if (!chargeDate) {
      toast.error("Please select a charge date");
      return;
    }

    setSubmitting(true);

    try {
      const payload =
        chargeType === "contract"
          ? { contract_id: selectedContractId }
          : { booking_id: selectedBookingId };

      const res = await fetch("/api/usage-charges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          description: description.trim(),
          quantity,
          unit_price: unitPrice,
          total: subtotal,
          gst_rate: gstRate,
          charge_date: chargeDate,
          notes: notes.trim() || undefined,
        }),
      });

      if (res.ok) {
        toast.success("Charge logged successfully");
        resetForm();
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to add charge");
      }
    } catch {
      toast.error("Failed to add charge");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) resetForm();
    onOpenChange(value);
  };

  const bookingCustomerLabel = (b: Booking) =>
    b.guest_name ||
    (b.lead
      ? b.lead.company || `${b.lead.first_name} ${b.lead.last_name}`
      : "Unknown");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Charge</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Charge type toggle — hide if pre-locked to a specific source */}
          {!contractId && !bookingId && (
            <div className="space-y-2">
              <Label>Charge Against</Label>
              <div className="flex rounded-lg border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setChargeType("contract")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors ${
                    chargeType === "contract"
                      ? "bg-primary text-primary-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <FileText className="h-4 w-4" />
                  Active Contract
                </button>
                <button
                  type="button"
                  onClick={() => setChargeType("booking")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors ${
                    chargeType === "booking"
                      ? "bg-primary text-primary-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <CalendarDays className="h-4 w-4" />
                  Past Booking
                </button>
              </div>
            </div>
          )}

          {/* ── CONTRACT MODE ── */}
          {chargeType === "contract" && (
            <div className="space-y-2">
              <Label>
                Contract <span className="text-destructive">*</span>
              </Label>
              {loadingContracts ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading contracts...
                </div>
              ) : contracts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No active contracts found.
                </p>
              ) : (
                <Select
                  value={selectedContractId}
                  onValueChange={setSelectedContractId}
                  disabled={!!contractId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a contract" />
                  </SelectTrigger>
                  <SelectContent>
                    {contracts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.contract_number}
                        {c.lead
                          ? ` — ${c.lead.company || `${c.lead.first_name} ${c.lead.last_name}`}`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* ── BOOKING MODE ── */}
          {chargeType === "booking" && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>
                  Booking <span className="text-destructive">*</span>
                </Label>
                {!bookingId && (
                  <Input
                    placeholder="Search by booking # or customer name..."
                    value={bookingSearch}
                    onChange={(e) => setBookingSearch(e.target.value)}
                  />
                )}
                {loadingBookings ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading bookings...
                  </div>
                ) : filteredBookings.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">
                    {bookingSearch ? "No matching bookings found." : "No past bookings available."}
                  </p>
                ) : (
                  <Select
                    value={selectedBookingId}
                    onValueChange={setSelectedBookingId}
                    disabled={!!bookingId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a booking" />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredBookings.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.booking_number} — {bookingCustomerLabel(b)} (
                          {formatDate(b.booking_date)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Selected booking summary */}
              {selectedBooking && (
                <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold">
                      {selectedBooking.booking_number}
                    </span>
                    <span className="text-muted-foreground">
                      {formatDate(selectedBooking.booking_date)}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    Customer:{" "}
                    <span className="text-foreground font-medium">
                      {bookingCustomerLabel(selectedBooking)}
                    </span>
                  </div>
                  {selectedBooking.space && (
                    <div className="text-muted-foreground">
                      Space:{" "}
                      <span className="text-foreground">
                        {selectedBooking.space.name}
                      </span>
                    </div>
                  )}
                  <div className="text-muted-foreground">
                    Booking amount:{" "}
                    <span className="text-foreground font-medium">
                      {formatCurrency(selectedBooking.total_amount)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="charge-description">
              Description <span className="text-destructive">*</span>
            </Label>
            <Input
              id="charge-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                chargeType === "booking"
                  ? "e.g., Damage to equipment, Overtime charges..."
                  : "e.g., Additional meeting room hours"
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="charge-quantity">
                Quantity <span className="text-destructive">*</span>
              </Label>
              <Input
                id="charge-quantity"
                type="number"
                min={0.01}
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="charge-unit-price">
                Unit Price <span className="text-destructive">*</span>
              </Label>
              <Input
                id="charge-unit-price"
                type="number"
                min={0.01}
                step="any"
                value={unitPrice}
                onChange={(e) => setUnitPrice(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>

          {/* GST + Total breakdown — total_with_gst is what finance bills
              and what gets carried into Collect Payment / monthly statement.
              GST defaults to 18% but is editable for exempt items. */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Subtotal (ex-GST)</Label>
              <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-sm">
                {formatCurrency(subtotal)}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="charge-gst-rate" className="text-xs text-muted-foreground">GST %</Label>
              <Input
                id="charge-gst-rate"
                type="number"
                min={0}
                max={28}
                step="0.01"
                value={gstRate}
                onChange={(e) => setGstRate(parseFloat(e.target.value) || 0)}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">GST amount</Label>
              <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-sm">
                {formatCurrency(gstAmount)}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Total (incl. GST)</Label>
            <div className="rounded-md border-2 border-primary/30 bg-primary/5 px-3 py-2 text-base font-semibold">
              {formatCurrency(totalWithGst)}
            </div>
          </div>

          {/* Charge Date */}
          <div className="space-y-2">
            <Label htmlFor="charge-date">
              Charge Date <span className="text-destructive">*</span>
            </Label>
            <Input
              id="charge-date"
              type="date"
              value={chargeDate}
              onChange={(e) => setChargeDate(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="charge-notes">Notes</Label>
            <Textarea
              id="charge-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                submitting ||
                (chargeType === "contract" && contracts.length === 0)
              }
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Charge
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

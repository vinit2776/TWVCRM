"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import { Loader2, AlertCircle, FileText, CalendarCheck } from "lucide-react";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";

// ─── Local types ──────────────────────────────────────────────────────────────

interface Contract {
  id: string;
  contract_number: string;
  total_amount: number;
  lead?: { first_name: string; last_name: string; company?: string };
}

interface Booking {
  id: string;
  booking_number: string;
  booking_date: string;
  guest_name?: string;
  total_amount: number;
}

interface UsageCharge {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface GenerateStatementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  contractId?: string;
  bookingId?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GenerateStatementDialog({
  open,
  onOpenChange,
  onSuccess,
  contractId,
  bookingId,
}: GenerateStatementDialogProps) {
  // Determine initial mode from props
  const initialMode = bookingId ? "booking" : "contract";
  const [mode, setMode] = useState<"contract" | "booking">(initialMode);

  // Contract state
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [selectedContractId, setSelectedContractId] = useState(contractId || "");

  // Booking state
  const [bookingSearch, setBookingSearch] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [selectedBookingId, setSelectedBookingId] = useState(bookingId || "");
  const bookingSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Period + notes
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Preview state
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [fixedAmount, setFixedAmount] = useState<number>(0);
  const [pendingCharges, setPendingCharges] = useState<UsageCharge[]>([]);
  const [pendingChargesTotal, setPendingChargesTotal] = useState<number>(0);

  // ── Fetch contracts on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (open && mode === "contract") {
      setLoadingContracts(true);
      fetch("/api/contracts?status=active&limit=100")
        .then((res) => res.json())
        .then((json) => setContracts(json.data || []))
        .catch(() => setContracts([]))
        .finally(() => setLoadingContracts(false));
    }
  }, [open, mode]);

  // ── Fetch bookings (debounced server-side search) ────────────────────────────
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

  useEffect(() => {
    if (!open || mode !== "booking" || bookingId) return;
    if (bookingSearchTimer.current) clearTimeout(bookingSearchTimer.current);
    bookingSearchTimer.current = setTimeout(() => {
      fetchBookings(bookingSearch);
    }, 300);
    return () => {
      if (bookingSearchTimer.current) clearTimeout(bookingSearchTimer.current);
    };
  }, [bookingSearch, open, mode, bookingId, fetchBookings]);

  // ── Preview ──────────────────────────────────────────────────────────────────
  const fetchPreview = useCallback(async () => {
    const activeId = mode === "contract" ? selectedContractId : selectedBookingId;
    if (!activeId || !periodStart || !periodEnd) {
      setFixedAmount(0);
      setPendingCharges([]);
      setPendingChargesTotal(0);
      return;
    }

    setLoadingPreview(true);
    try {
      if (mode === "contract") {
        // Get contract fixed amount
        const contractRes = await fetch(`/api/contracts/${selectedContractId}`);
        if (contractRes.ok) {
          const j = await contractRes.json();
          setFixedAmount(j.data?.total_amount || 0);
        }
        // Get pending usage charges for contract
        const chargeParams = new URLSearchParams({
          contract_id: selectedContractId,
          status: "pending",
          date_from: periodStart,
          date_to: periodEnd,
        });
        const chargesRes = await fetch(`/api/usage-charges?${chargeParams}`);
        if (chargesRes.ok) {
          const j = await chargesRes.json();
          const charges = j.data || [];
          setPendingCharges(charges);
          setPendingChargesTotal(charges.reduce((s: number, c: UsageCharge) => s + (c.total || 0), 0));
        }
      } else {
        // Get booking fixed amount
        const found = bookings.find((b) => b.id === selectedBookingId);
        setFixedAmount(found?.total_amount || 0);
        // Get pending usage charges for booking
        const chargeParams = new URLSearchParams({
          booking_id: selectedBookingId,
          status: "pending",
          date_from: periodStart,
          date_to: periodEnd,
        });
        const chargesRes = await fetch(`/api/usage-charges?${chargeParams}`);
        if (chargesRes.ok) {
          const j = await chargesRes.json();
          const charges = j.data || [];
          setPendingCharges(charges);
          setPendingChargesTotal(charges.reduce((s: number, c: UsageCharge) => s + (c.total || 0), 0));
        }
      }
    } catch {
      // Silently fail preview; user can still submit
    } finally {
      setLoadingPreview(false);
    }
  }, [mode, selectedContractId, selectedBookingId, periodStart, periodEnd, bookings]);

  useEffect(() => {
    fetchPreview();
  }, [fetchPreview]);

  // ── Reset ────────────────────────────────────────────────────────────────────
  const resetForm = () => {
    setMode(initialMode);
    setSelectedContractId(contractId || "");
    setSelectedBookingId(bookingId || "");
    setBookingSearch("");
    setBookings([]);
    setPeriodStart("");
    setPeriodEnd("");
    setNotes("");
    setFixedAmount(0);
    setPendingCharges([]);
    setPendingChargesTotal(0);
  };

  // ── Submit ───────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (mode === "contract" && !selectedContractId) {
      toast.error("Please select a contract");
      return;
    }
    if (mode === "booking" && !selectedBookingId) {
      toast.error("Please select a booking");
      return;
    }
    if (!periodStart) {
      toast.error("Please select a period start date");
      return;
    }
    if (!periodEnd) {
      toast.error("Please select a period end date");
      return;
    }
    if (new Date(periodEnd) <= new Date(periodStart)) {
      toast.error("Period end must be after period start");
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, string | undefined> = {
        period_start: periodStart,
        period_end: periodEnd,
        notes: notes.trim() || undefined,
      };
      if (mode === "contract") payload.contract_id = selectedContractId;
      else payload.booking_id = selectedBookingId;

      const res = await fetch("/api/billing-statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success("Billing statement generated successfully");
        resetForm();
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to generate statement");
      }
    } catch {
      toast.error("Failed to generate statement");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) resetForm();
    onOpenChange(value);
  };

  const grandTotal = fixedAmount + pendingChargesTotal;
  const hasSelection = mode === "contract" ? !!selectedContractId : !!selectedBookingId;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate Billing Statement</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Mode toggle */}
          {!contractId && !bookingId && (
            <div className="flex rounded-lg border overflow-hidden">
              <button
                type="button"
                onClick={() => { setMode("contract"); setSelectedBookingId(""); }}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors ${
                  mode === "contract"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <FileText className="h-4 w-4" />
                Active Contract
              </button>
              <button
                type="button"
                onClick={() => { setMode("booking"); setSelectedContractId(""); }}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors ${
                  mode === "booking"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <CalendarCheck className="h-4 w-4" />
                Past Booking
              </button>
            </div>
          )}

          {/* Contract selector */}
          {mode === "contract" && (
            <div className="space-y-2">
              <Label htmlFor="stmt-contract">
                Contract <span className="text-destructive">*</span>
              </Label>
              {loadingContracts ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading contracts...
                </div>
              ) : contracts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No active contracts found.</p>
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

          {/* Booking picker */}
          {mode === "booking" && (
            <div className="space-y-2">
              <Label htmlFor="stmt-booking">
                Booking <span className="text-destructive">*</span>
              </Label>
              {bookingId ? (
                <p className="text-sm text-muted-foreground">Pre-selected booking.</p>
              ) : (
                <>
                  <Input
                    id="stmt-booking-search"
                    placeholder="Search by booking # or guest name…"
                    value={bookingSearch}
                    onChange={(e) => setBookingSearch(e.target.value)}
                  />
                  {loadingBookings ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Searching bookings…
                    </div>
                  ) : bookings.length === 0 && bookingSearch.trim() ? (
                    <p className="text-sm text-muted-foreground py-1">No matching bookings found.</p>
                  ) : bookings.length > 0 ? (
                    <Select
                      value={selectedBookingId}
                      onValueChange={setSelectedBookingId}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a booking" />
                      </SelectTrigger>
                      <SelectContent>
                        {bookings.map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.booking_number}
                            {b.guest_name ? ` — ${b.guest_name}` : ""}
                            {` (${formatDate(b.booking_date)})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </>
              )}
            </div>
          )}

          {/* Period */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="stmt-period-start">
                Period Start <span className="text-destructive">*</span>
              </Label>
              <Input
                id="stmt-period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stmt-period-end">
                Period End <span className="text-destructive">*</span>
              </Label>
              <Input
                id="stmt-period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>

          {/* Preview */}
          {hasSelection && periodStart && periodEnd && (
            <div className="rounded-md border bg-muted/30 p-4 space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                Statement Preview
                {loadingPreview && <Loader2 className="h-3 w-3 animate-spin" />}
              </h4>
              {!loadingPreview && (
                <>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {mode === "contract" ? "Fixed Amount (from contract)" : "Booking Amount"}
                      </span>
                      <span className="font-medium">{formatCurrency(fixedAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Pending Usage Charges ({pendingCharges.length} item{pendingCharges.length !== 1 ? "s" : ""})
                      </span>
                      <span className="font-medium">{formatCurrency(pendingChargesTotal)}</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between font-semibold">
                      <span>Estimated Total</span>
                      <span>{formatCurrency(grandTotal)}</span>
                    </div>
                  </div>
                  {pendingCharges.length === 0 && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <AlertCircle className="h-3 w-3" />
                      No pending usage charges found for this period.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="stmt-notes">Notes</Label>
            <Textarea
              id="stmt-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || (mode === "contract" ? contracts.length === 0 : false)}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate Statement
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

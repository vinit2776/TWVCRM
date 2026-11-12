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
import {
  Loader2, AlertCircle, FileText, CalendarCheck,
  Plus, Trash2, Eye, EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate, formatCurrency, preventEnterSubmit } from "@/lib/utils";
const uid = () => Math.random().toString(36).slice(2, 10);

// ─── Local types ──────────────────────────────────────────────────────────────

interface Contract {
  id: string;
  contract_number: string;
  total_amount: number;
  tax_percentage?: number;
  lead?: { first_name: string; last_name: string; company?: string };
}

interface Booking {
  id: string;
  booking_number: string;
  booking_date: string;
  guest_name?: string;
  total_amount: number;
  tax_percentage?: number;
}

interface UsageCharge {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

/** A charge row the user adds directly in this dialog before generating */
interface AdHocCharge {
  localId: string;
  description: string;
  quantity: number | "";
  unitPrice: number | "";
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface GenerateStatementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  contractId?: string;
  bookingId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function adHocTotal(c: AdHocCharge): number {
  const qty = Number(c.quantity) || 0;
  const price = Number(c.unitPrice) || 0;
  return parseFloat((qty * price).toFixed(2));
}

function fmt(n: number) {
  return formatCurrency(n);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GenerateStatementDialog({
  open,
  onOpenChange,
  onSuccess,
  contractId,
  bookingId,
}: GenerateStatementDialogProps) {
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

  // Preview data
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [fixedAmount, setFixedAmount] = useState<number>(0);
  const [taxPercentage, setTaxPercentage] = useState<number>(0);
  const [pendingCharges, setPendingCharges] = useState<UsageCharge[]>([]);
  const [showPreview, setShowPreview] = useState(false);

  // Ad-hoc charges added in this dialog
  const [adHocCharges, setAdHocCharges] = useState<AdHocCharge[]>([]);

  // ── Fetch contracts ────────────────────────────────────────────────────────
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

  // ── Fetch bookings ─────────────────────────────────────────────────────────
  const fetchBookings = useCallback(
    (search: string) => {
      if (bookingId) return;
      setLoadingBookings(true);
      const params = new URLSearchParams({ status: "checked_out,no_show,cancelled", limit: "100", page: "1" });
      if (search.trim()) params.set("search", search.trim());
      fetch(`/api/bookings?${params}`)
        .then((res) => res.json())
        .then((json) => setBookings(json.data || []))
        .catch(() => setBookings([]))
        .finally(() => setLoadingBookings(false));
    },
    [bookingId],
  );

  useEffect(() => {
    if (!open || mode !== "booking" || bookingId) return;
    if (bookingSearchTimer.current) clearTimeout(bookingSearchTimer.current);
    bookingSearchTimer.current = setTimeout(() => fetchBookings(bookingSearch), 300);
    return () => { if (bookingSearchTimer.current) clearTimeout(bookingSearchTimer.current); };
  }, [bookingSearch, open, mode, bookingId, fetchBookings]);

  // ── Fetch preview data ─────────────────────────────────────────────────────
  const fetchPreview = useCallback(async () => {
    const activeId = mode === "contract" ? selectedContractId : selectedBookingId;
    if (!activeId || !periodStart || !periodEnd) {
      setFixedAmount(0); setTaxPercentage(0); setPendingCharges([]); return;
    }
    setLoadingPreview(true);
    try {
      if (mode === "contract") {
        const [contractRes, chargesRes] = await Promise.all([
          fetch(`/api/contracts/${selectedContractId}`),
          fetch(`/api/usage-charges?contract_id=${selectedContractId}&status=pending&date_from=${periodStart}&date_to=${periodEnd}`),
        ]);
        if (contractRes.ok) {
          const j = await contractRes.json();
          setFixedAmount(j.data?.total_amount || 0);
          setTaxPercentage(j.data?.tax_percentage || 18);
        }
        if (chargesRes.ok) {
          const j = await chargesRes.json();
          setPendingCharges(j.data || []);
        }
      } else {
        const found = bookings.find((b) => b.id === selectedBookingId);
        setFixedAmount(found?.total_amount || 0);
        setTaxPercentage(found?.tax_percentage || 18);
        const chargesRes = await fetch(`/api/usage-charges?booking_id=${selectedBookingId}&status=pending&date_from=${periodStart}&date_to=${periodEnd}`);
        if (chargesRes.ok) {
          const j = await chargesRes.json();
          setPendingCharges(j.data || []);
        }
      }
    } catch { /* silent */ } finally { setLoadingPreview(false); }
  }, [mode, selectedContractId, selectedBookingId, periodStart, periodEnd, bookings]);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  // ── Ad-hoc charge helpers ──────────────────────────────────────────────────
  const addAdHocCharge = () => {
    setAdHocCharges((prev) => [...prev, { localId: uid(), description: "", quantity: 1, unitPrice: "" }]);
  };

  const updateAdHocCharge = (localId: string, field: keyof Omit<AdHocCharge, "localId">, value: string | number) => {
    setAdHocCharges((prev) =>
      prev.map((c) => c.localId === localId ? { ...c, [field]: value } : c)
    );
  };

  const removeAdHocCharge = (localId: string) => {
    setAdHocCharges((prev) => prev.filter((c) => c.localId !== localId));
  };

  // ── Computed totals ────────────────────────────────────────────────────────
  const pendingChargesTotal = pendingCharges.reduce((s, c) => s + (c.total || 0), 0);
  const adHocTotal_sum = adHocCharges.reduce((s, c) => s + adHocTotal(c), 0);
  const subtotal = fixedAmount + pendingChargesTotal + adHocTotal_sum;
  const taxAmount = parseFloat((subtotal * taxPercentage / 100).toFixed(2));
  const grandTotal = parseFloat((subtotal + taxAmount).toFixed(2));

  // ── Reset ──────────────────────────────────────────────────────────────────
  const resetForm = () => {
    setMode(initialMode);
    setSelectedContractId(contractId || "");
    setSelectedBookingId(bookingId || "");
    setBookingSearch(""); setBookings([]);
    setPeriodStart(""); setPeriodEnd(""); setNotes("");
    setFixedAmount(0); setTaxPercentage(0); setPendingCharges([]);
    setAdHocCharges([]); setShowPreview(false);
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "contract" && !selectedContractId) { toast.error("Please select a contract"); return; }
    if (mode === "booking" && !selectedBookingId) { toast.error("Please select a booking"); return; }
    if (!periodStart) { toast.error("Please select a period start date"); return; }
    if (!periodEnd) { toast.error("Please select a period end date"); return; }
    if (new Date(periodEnd) <= new Date(periodStart)) { toast.error("Period end must be after period start"); return; }

    // Validate ad-hoc charges
    for (const c of adHocCharges) {
      if (!c.description.trim()) { toast.error("All charge descriptions are required"); return; }
      if (!c.quantity || Number(c.quantity) <= 0) { toast.error(`Quantity must be > 0 for "${c.description || "charge"}"`); return; }
      if (!c.unitPrice || Number(c.unitPrice) <= 0) { toast.error(`Unit price must be > 0 for "${c.description || "charge"}"`); return; }
    }

    setSubmitting(true);
    try {
      // 1. POST ad-hoc charges first
      const chargeBase = mode === "contract"
        ? { contract_id: selectedContractId }
        : { booking_id: selectedBookingId };

      for (const c of adHocCharges) {
        const qty = Number(c.quantity);
        const price = Number(c.unitPrice);
        const res = await fetch("/api/usage-charges", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...chargeBase,
            description: c.description.trim(),
            quantity: qty,
            unit_price: price,
            total: parseFloat((qty * price).toFixed(2)),
            charge_date: periodEnd,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          toast.error(err?.error || `Failed to save charge: ${c.description}`);
          setSubmitting(false);
          return;
        }
      }

      // 2. Generate billing statement
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

  const hasSelection = mode === "contract" ? !!selectedContractId : !!selectedBookingId;
  const canPreview = hasSelection && !!periodStart && !!periodEnd;
  const totalNewCharges = adHocCharges.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate Billing Statement</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-5">

          {/* ── Mode toggle ── */}
          {!contractId && !bookingId && (
            <div className="flex rounded-lg border overflow-hidden">
              <button type="button" onClick={() => { setMode("contract"); setSelectedBookingId(""); }}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors ${mode === "contract" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"}`}>
                <FileText className="h-4 w-4" /> Active Contract
              </button>
              <button type="button" onClick={() => { setMode("booking"); setSelectedContractId(""); }}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors ${mode === "booking" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"}`}>
                <CalendarCheck className="h-4 w-4" /> Past Booking
              </button>
            </div>
          )}

          {/* ── Contract selector ── */}
          {mode === "contract" && (
            <div className="space-y-1.5">
              <Label>Contract <span className="text-destructive">*</span></Label>
              {loadingContracts ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading contracts…</div>
              ) : contracts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No active contracts found.</p>
              ) : (
                <Select value={selectedContractId} onValueChange={setSelectedContractId} disabled={!!contractId}>
                  <SelectTrigger><SelectValue placeholder="Select a contract" /></SelectTrigger>
                  <SelectContent>
                    {contracts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.contract_number}{c.lead ? ` — ${c.lead.company || `${c.lead.first_name} ${c.lead.last_name}`}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* ── Booking picker ── */}
          {mode === "booking" && (
            <div className="space-y-1.5">
              <Label>Booking <span className="text-destructive">*</span></Label>
              {bookingId ? <p className="text-sm text-muted-foreground">Pre-selected booking.</p> : (
                <>
                  <Input placeholder="Search by booking # or guest name…" value={bookingSearch} onChange={(e) => setBookingSearch(e.target.value)} />
                  {loadingBookings ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-1"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>
                  ) : bookings.length === 0 && bookingSearch.trim() ? (
                    <p className="text-sm text-muted-foreground py-1">No matching bookings found.</p>
                  ) : bookings.length > 0 ? (
                    <Select value={selectedBookingId} onValueChange={setSelectedBookingId}>
                      <SelectTrigger><SelectValue placeholder="Select a booking" /></SelectTrigger>
                      <SelectContent>
                        {bookings.map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.booking_number}{b.guest_name ? ` — ${b.guest_name}` : ""} ({formatDate(b.booking_date)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </>
              )}
            </div>
          )}

          {/* ── Period ── */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Period Start <span className="text-destructive">*</span></Label>
              <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Period End <span className="text-destructive">*</span></Label>
              <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </div>
          </div>

          {/* ── Charges section (visible once contract + period chosen) ── */}
          {canPreview && (
            <div className="rounded-lg border overflow-hidden">

              {/* Section header */}
              <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  Charges
                  {loadingPreview && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                </h4>
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={addAdHocCharge}>
                    <Plus className="h-3.5 w-3.5" /> Add Charge
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1.5 text-muted-foreground"
                    onClick={() => setShowPreview((v) => !v)}>
                    {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showPreview ? "Hide Preview" : "Preview Bill"}
                  </Button>
                </div>
              </div>

              {!loadingPreview && (
                <div className="divide-y text-sm">

                  {/* ── Fixed / base amount ── */}
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-muted-foreground">
                      {mode === "contract" ? "Monthly membership fee (from contract)" : "Booking amount"}
                    </span>
                    <span className="font-medium tabular-nums">{fmt(fixedAmount)}</span>
                  </div>

                  {/* ── Existing pending usage charges ── */}
                  {pendingCharges.length > 0 && (
                    <>
                      <div className="px-4 py-2 bg-muted/20">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          Pending Usage Charges ({pendingCharges.length})
                        </span>
                      </div>
                      {pendingCharges.map((c) => (
                        <div key={c.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                          <div className="flex-1 min-w-0">
                            <span className="truncate block">{c.description}</span>
                            <span className="text-xs text-muted-foreground">
                              {c.quantity} × {fmt(c.unit_price)}
                            </span>
                          </div>
                          <span className="font-medium tabular-nums shrink-0">{fmt(c.total)}</span>
                        </div>
                      ))}
                    </>
                  )}

                  {pendingCharges.length === 0 && adHocCharges.length === 0 && (
                    <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      No pending usage charges for this period. Use <strong>Add Charge</strong> to include additional services.
                    </div>
                  )}

                  {/* ── Ad-hoc charges (editable rows) ── */}
                  {adHocCharges.length > 0 && (
                    <>
                      <div className="px-4 py-2 bg-amber-50 border-b border-amber-100">
                        <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
                          Additional Charges — Added Now ({adHocCharges.length})
                        </span>
                      </div>
                      {adHocCharges.map((c, i) => (
                        <div key={c.localId} className="px-4 py-2.5 bg-amber-50/50 space-y-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                            <Input
                              placeholder="Description / service name"
                              value={c.description}
                              onChange={(e) => updateAdHocCharge(c.localId, "description", e.target.value)}
                              className="flex-1 h-8 text-sm"
                            />
                            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                              onClick={() => removeAdHocCharge(c.localId)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="flex items-center gap-2 ml-5">
                            <div className="flex items-center gap-1.5 flex-1">
                              <Label className="text-xs text-muted-foreground shrink-0">Qty</Label>
                              <Input type="number" min={0.01} step="any" placeholder="1"
                                value={c.quantity}
                                onChange={(e) => updateAdHocCharge(c.localId, "quantity", e.target.value === "" ? "" : parseFloat(e.target.value))}
                                className="w-20 h-7 text-sm" />
                            </div>
                            <div className="flex items-center gap-1.5 flex-1">
                              <Label className="text-xs text-muted-foreground shrink-0">₹ / unit</Label>
                              <Input type="number" min={0} step="any" placeholder="0"
                                value={c.unitPrice}
                                onChange={(e) => updateAdHocCharge(c.localId, "unitPrice", e.target.value === "" ? "" : parseFloat(e.target.value))}
                                className="w-28 h-7 text-sm" />
                            </div>
                            <div className="flex items-center gap-1.5 ml-auto">
                              <span className="text-xs text-muted-foreground">Total:</span>
                              <span className="text-sm font-semibold tabular-nums text-amber-700 w-24 text-right">
                                {fmt(adHocTotal(c))}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </>
                  )}

                  {/* ── Totals summary ── */}
                  {showPreview && (
                    <>
                      <div className="px-4 py-2 bg-muted/20">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bill Summary</span>
                      </div>

                      {/* Line-item breakdown for preview */}
                      <div className="px-4 py-2.5 space-y-1.5 bg-muted/10">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{mode === "contract" ? "Membership fee" : "Booking amount"}</span>
                          <span className="tabular-nums">{fmt(fixedAmount)}</span>
                        </div>
                        {pendingCharges.length > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Usage charges ({pendingCharges.length} item{pendingCharges.length !== 1 ? "s" : ""})</span>
                            <span className="tabular-nums">{fmt(pendingChargesTotal)}</span>
                          </div>
                        )}
                        {totalNewCharges > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Additional charges ({totalNewCharges} item{totalNewCharges !== 1 ? "s" : ""})</span>
                            <span className="tabular-nums text-amber-700">{fmt(adHocTotal_sum)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-sm pt-1 border-t">
                          <span className="text-muted-foreground">Subtotal (pre-GST)</span>
                          <span className="font-medium tabular-nums">{fmt(subtotal)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">GST @ {taxPercentage}%</span>
                          <span className="tabular-nums">{fmt(taxAmount)}</span>
                        </div>
                        <div className="flex justify-between font-bold text-base pt-1 border-t">
                          <span>Grand Total</span>
                          <span className="text-[#015E65] tabular-nums">{fmt(grandTotal)}</span>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Always show grand total strip at bottom */}
                  {!showPreview && (
                    <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-t">
                      <span className="text-sm font-semibold">Estimated Total (incl. GST)</span>
                      <span className="font-bold text-[#015E65] tabular-nums">{fmt(grandTotal)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Notes ── */}
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" rows={2} />
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting || (mode === "contract" && contracts.length === 0)}
              style={{ backgroundColor: "#015E65", color: "white" }}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? "Generating…" : `Generate Statement${totalNewCharges > 0 ? ` (+${totalNewCharges} charge${totalNewCharges !== 1 ? "s" : ""})` : ""}`}
            </Button>
          </DialogFooter>

        </form>
      </DialogContent>
    </Dialog>
  );
}

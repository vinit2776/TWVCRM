"use client";

import { memo } from "react";
import { IndianRupee, Loader2, TicketCheck, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";
import {
  BOOKING_COMPLIMENTARY_REASONS,
  BOOKING_COMPLIMENTARY_REASON_LABELS,
} from "@/lib/constants";
import { useBookingForm } from "./booking-form-context";

export const BookingSummarySection = memo(function BookingSummarySection() {
  const {
    saving, sendSms, setSendSms, sendWhatsapp, setSendWhatsapp,
    selectedSpace, bookingDate, startTime, endTime, isDayPass, numSeats,
    durationHours, customRate, setCustomRate, effectiveRate, roomCost,
    facilityCost, totalAmount, gstAmount, totalAmountWithGst,
    spaceId, bookerPhone, allDangerCautionsAcked, handleSubmit,
    usePrepaid, activePurchase, selectedChargeIds, outstandingCharges,
    complimentaryReason, setComplimentaryReason, complimentaryDetails, setComplimentaryDetails,
    formatTime12, formatDuration,
  } = useBookingForm();

  const GST_RATE = 18;

  return (
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
            <p className="font-medium text-sm">{isDayPass ? `${numSeats} seat${numSeats > 1 ? "s" : ""} · 1 day` : formatDuration(durationHours)}</p>
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
            <span className="text-muted-foreground">{isDayPass ? `Day Pass (${numSeats} seat${numSeats > 1 ? "s" : ""})` : `Room (${formatDuration(durationHours)})`}</span>
            <span>{formatCurrency(roomCost)}</span>
          </div>
          {facilityCost > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Facilities</span>
              <span>{formatCurrency(facilityCost)}</span>
            </div>
          )}
          {totalAmount > 0 && (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>GST ({GST_RATE}%)</span>
              <span>{formatCurrency(gstAmount)}</span>
            </div>
          )}
          {/* Prepaid pricing rows */}
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
          {/* Past dues */}
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

        {/* Complimentary booking */}
        {totalAmountWithGst <= 0 && spaceId && (
          <div className="rounded-md border-2 border-emerald-300 bg-emerald-50/50 p-3 mt-3 space-y-2.5">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-900">
              <Gift className="h-4 w-4" />
              Complimentary booking — required reason
            </div>
            <p className="text-[11px] text-emerald-900">
              Total is ₹0. Pick why this booking is being given complimentary so finance can report on it.
              The booking will be auto-marked as waived (not pending) on creation.
            </p>
            <div className="space-y-1">
              <Label className="text-xs">Reason *</Label>
              <div className="grid grid-cols-1 gap-1">
                {BOOKING_COMPLIMENTARY_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setComplimentaryReason(r)}
                    className={`text-left rounded-md border bg-white px-3 py-1.5 text-xs transition-colors ${
                      complimentaryReason === r
                        ? "border-emerald-500 bg-emerald-100 ring-1 ring-emerald-400"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    {BOOKING_COMPLIMENTARY_REASON_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Details {complimentaryReason === "other" && <span className="text-destructive">*</span>}
              </Label>
              <Input
                value={complimentaryDetails}
                onChange={(e) => setComplimentaryDetails(e.target.value)}
                placeholder={
                  complimentaryReason === "other"
                    ? "Please describe the reason"
                    : "Optional context (e.g., 'Mic broke last visit, comping a 2-hour session')"
                }
                className="h-8 text-sm bg-white"
              />
            </div>
          </div>
        )}

        {/* Notification preferences */}
        <div className="flex items-center gap-4 mt-3 pt-3 border-t">
          <span className="text-xs text-muted-foreground">Notify customer:</span>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={sendSms} onChange={(e) => setSendSms(e.target.checked)} className="h-3.5 w-3.5 rounded" />
            <span>SMS</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={sendWhatsapp} onChange={(e) => setSendWhatsapp(e.target.checked)} className="h-3.5 w-3.5 rounded" />
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
  );
});

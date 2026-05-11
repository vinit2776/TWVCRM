"use client";

import { memo } from "react";
import { Banknote, CreditCard, Smartphone, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Repeat } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { BookingNotesTemplates } from "@/components/bookings/booking-notes-templates";
import { useBookingForm } from "./booking-form-context";

export const PaymentSection = memo(function PaymentSection() {
  const {
    customerType, collectAdvancePayment, setCollectAdvancePayment,
    advancePaymentMode, setAdvancePaymentMode, advancePaymentAmount, setAdvancePaymentAmount,
    advancePaymentReference, setAdvancePaymentReference, razorpayEnabled,
    totalAmountWithGst, notes, setNotes, aggregatorBookingId, setAggregatorBookingId,
    spaceId, startTime, endTime, locationId, setRecurringDialogOpen,
  } = useBookingForm();

  return (
    <>
      {/* Payment (walk-ins only) */}
      {customerType === "walk_in" && (
        <Card>
          <CardHeader><CardTitle className="text-base">5. Payment</CardTitle></CardHeader>
          <CardContent className="space-y-4">
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
                      type="number" step="0.01" min="1"
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
                          key={mode} type="button"
                          variant={advancePaymentMode === mode ? "default" : "outline"}
                          size="sm" className="text-xs flex-1 gap-1"
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

      {/* Notes */}
      <Card>
        <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any special requirements..." rows={3} />
          <BookingNotesTemplates onInsert={(text) => setNotes(prev => prev ? `${prev}\n${text}` : text)} />
          <div className="space-y-1.5 pt-1">
            <Label className="text-sm">Aggregator Booking ID <span className="text-muted-foreground font-normal text-xs">(Optional — if referred by an aggregator)</span></Label>
            <Input value={aggregatorBookingId} onChange={(e) => setAggregatorBookingId(e.target.value)} placeholder="e.g. AGG-12345" />
          </div>
        </CardContent>
      </Card>

      {/* Recurring */}
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
              variant="outline" size="sm"
              onClick={() => setRecurringDialogOpen(true)}
              disabled={!spaceId || !startTime || !endTime || !locationId}
            >
              <Repeat className="mr-1 h-4 w-4" />
              Set Up Recurring
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
});

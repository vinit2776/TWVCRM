"use client";

/**
 * CancelBookingDialog — guided cancellation flow.
 *
 * Replaces the bare confirm("Are you sure?") flow with a structured
 * dialog that captures:
 *
 *   1. Reason (locked picklist)
 *   2. Optional details — required when reason = "other"
 *   3. Optional caution to add to the lead's profile (auto-prefilled
 *      to danger when reason = "suspected_fake_booking")
 *   4. If payment was collected: refund-eligibility branch
 *      - Yes → mini refund-request form (amount + reason + details)
 *              → submitted as pending_approval, manager/admin will
 *              approve in the finance module
 *      - No  → payment retained; finance is flagged to issue GST
 *              invoice for the kept amount
 *
 * Submits to POST /api/bookings/[id]/cancel as a single body.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, AlertTriangle, ShieldAlert, IndianRupee, MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import {
  BOOKING_CANCELLATION_REASONS,
  BOOKING_CANCELLATION_REASON_LABELS,
  REFUND_REQUEST_REASON_LABELS,
  LEAD_CAUTION_SEVERITY_COLORS,
} from "@/lib/constants";
import type { Booking, BookingPayment, BookingCancellationReason, LeadCautionSeverity } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: Booking;
  existingPayments: BookingPayment[];
  /** Called after a successful cancel so the parent refetches. */
  onCancelled: () => void;
}

export function CancelBookingDialog({
  open, onOpenChange, booking, existingPayments, onCancelled,
}: Props) {
  // ── Form state ───────────────────────────────────────────────────
  const [reason, setReason] = useState<BookingCancellationReason | "">("");
  const [details, setDetails] = useState("");

  // Caution section — collapsed until the user expands it. Auto-
  // expanded when reason flips to suspected_fake_booking so staff can
  // edit the prefilled note before submit.
  const [cautionExpanded, setCautionExpanded] = useState(false);
  const [cautionNote, setCautionNote] = useState("");
  const [cautionSeverity, setCautionSeverity] = useState<LeadCautionSeverity>("warning");

  // Refund branch — only shown when payment was collected.
  const [refundEligible, setRefundEligible] = useState<"yes" | "no" | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState<string>("centre_at_fault");
  const [refundDetails, setRefundDetails] = useState("");

  const [submitting, setSubmitting] = useState(false);

  // Reset everything whenever the dialog opens
  useEffect(() => {
    if (!open) return;
    setReason("");
    setDetails("");
    setCautionExpanded(false);
    setCautionNote("");
    setCautionSeverity("warning");
    setRefundEligible(null);
    setRefundDetails("");
    setRefundReason("centre_at_fault");

    // Pre-fill the refund amount with the verified-payment total — staff
    // can edit down for partial refunds.
    const totalCollected = existingPayments
      .filter((p) => p.status === "verified")
      .reduce((s, p) => s + Number(p.amount), 0);
    setRefundAmount(totalCollected > 0 ? totalCollected.toFixed(2) : "");
  }, [open, existingPayments]);

  // When reason hits suspected_fake_booking, expand the caution section
  // and prefill a danger-severity note.
  useEffect(() => {
    if (reason === "suspected_fake_booking") {
      setCautionExpanded(true);
      setCautionSeverity("danger");
      if (!cautionNote.trim()) {
        setCautionNote(
          `Suspected fake booking — ${booking.booking_number} (${booking.booking_date})`
        );
      }
    }
    // intentionally excluding cautionNote from deps to avoid clobbering
    // staff edits once they start typing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reason, booking.booking_number, booking.booking_date]);

  const totalCollected = existingPayments
    .filter((p) => p.status === "verified")
    .reduce((s, p) => s + Number(p.amount), 0);
  const hasCollectedPayment = totalCollected > 0
    || ["paid", "prepaid"].includes(booking.payment_status);

  const submit = async () => {
    if (!reason) {
      toast.error("Please pick a cancellation reason");
      return;
    }
    if (reason === "other" && !details.trim()) {
      toast.error('Please add details — "Other" requires a reason');
      return;
    }
    if (hasCollectedPayment && refundEligible === null) {
      toast.error("Please choose whether the cancellation qualifies for a refund");
      return;
    }
    if (cautionExpanded && !cautionNote.trim()) {
      toast.error("Caution note is empty — fill it in or close the section");
      return;
    }
    if (refundEligible === "yes") {
      const amt = parseFloat(refundAmount);
      if (!Number.isFinite(amt) || amt <= 0 || amt > totalCollected + 0.01) {
        toast.error(`Refund amount must be between ₹0 and ${formatCurrency(totalCollected)}`);
        return;
      }
      if (refundReason === "other" && !refundDetails.trim()) {
        toast.error('Refund details required when reason is "Other"');
        return;
      }
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        reason,
        details: details.trim() || undefined,
      };
      if (cautionExpanded && cautionNote.trim()) {
        body.caution = {
          note: cautionNote.trim(),
          severity: cautionSeverity,
        };
      }
      if (refundEligible === "yes") {
        body.refund_request = {
          amount: parseFloat(refundAmount),
          reason: refundReason,
          details: refundDetails.trim() || undefined,
        };
      }

      const res = await fetch(`/api/bookings/${booking.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to cancel booking");
        return;
      }

      // Compose a useful success toast that names what side effects fired.
      const bits: string[] = [];
      if (json.refund_request_id) bits.push("refund request submitted");
      if (json.caution_created) bits.push("caution added to customer profile");
      if (json.gst_invoice_required) bits.push("flagged for GST invoice");
      toast.success(
        `Booking cancelled${bits.length ? ` — ${bits.join(" · ")}` : ""}`
      );
      // Ruijie has no revocation API, so cancelling does NOT cut the guest's
      // WiFi. Say so explicitly — staff otherwise assume access ended with the
      // booking, and the guest stays online until the code expires.
      if (json.vouchers_still_live > 0) {
        toast.warning(
          `${json.vouchers_still_live} WiFi code${json.vouchers_still_live === 1 ? "" : "s"} still work${json.vouchers_still_live === 1 ? "s" : ""} — this location's provider (Ruijie) can't disable codes. The guest stays online until it expires.`,
          { duration: 10000 }
        );
      }
      onCancelled();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            Cancel booking — {booking.booking_number}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Reason picklist */}
          <div className="space-y-2">
            <Label>Reason *</Label>
            <div className="grid grid-cols-1 gap-1.5">
              {BOOKING_CANCELLATION_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`text-left rounded-md border px-3 py-2 text-sm transition-colors ${
                    reason === r
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  {BOOKING_CANCELLATION_REASON_LABELS[r]}
                </button>
              ))}
            </div>
          </div>

          {/* Details — required when reason = other */}
          <div className="space-y-1">
            <Label htmlFor="cancel-details" className="text-xs">
              Details {reason === "other" && <span className="text-destructive">*</span>}
            </Label>
            <Textarea
              id="cancel-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder={
                reason === "other"
                  ? "Please describe the cancellation reason"
                  : "Optional context for finance / management"
              }
              rows={2}
              className="text-sm"
            />
          </div>

          {/* Caution section — collapsible */}
          <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4 text-amber-700" />
                <Label className="text-sm">Add a caution to this customer&apos;s profile?</Label>
              </div>
              <button
                type="button"
                onClick={() => setCautionExpanded((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {cautionExpanded ? "Hide" : "Add"}
              </button>
            </div>
            {!cautionExpanded ? (
              <p className="text-[11px] text-amber-900">
                Cautions warn future staff before booking this customer again — useful for
                fake bookings, repeat no-shows, or behavioural flags.
              </p>
            ) : (
              <div className="space-y-2.5 pt-1">
                <div className="flex gap-1.5">
                  {(["info", "warning", "danger"] as LeadCautionSeverity[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setCautionSeverity(s)}
                      className={`text-[11px] uppercase font-semibold px-2.5 py-1 rounded border ${
                        cautionSeverity === s
                          ? LEAD_CAUTION_SEVERITY_COLORS[s] + " ring-1 ring-current"
                          : "bg-white text-muted-foreground border-muted"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <Textarea
                  value={cautionNote}
                  onChange={(e) => setCautionNote(e.target.value)}
                  placeholder="What should future staff know about this customer?"
                  rows={2}
                  className="text-sm bg-white"
                />
                <p className="text-[11px] text-muted-foreground">
                  Will appear on this customer&apos;s lead profile and as a banner when staff books them again.
                </p>
              </div>
            )}
          </div>

          {/* Refund branch — only when payment was collected */}
          {hasCollectedPayment && (
            <div className="rounded-md border border-blue-200 bg-blue-50/50 p-3 space-y-2.5">
              <div className="flex items-center gap-1.5">
                <IndianRupee className="h-4 w-4 text-blue-700" />
                <Label className="text-sm">Does this qualify for a refund?</Label>
              </div>
              <p className="text-[11px] text-blue-900">
                {formatCurrency(totalCollected)} was collected on this booking.
                Pick &quot;Yes&quot; to send a refund request to manager / admin for approval, or
                &quot;No&quot; to retain the payment (finance will issue a GST invoice for it).
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setRefundEligible("no")}
                  className={`rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                    refundEligible === "no"
                      ? "border-slate-500 bg-slate-50 ring-1 ring-slate-400"
                      : "bg-white hover:bg-muted/40"
                  }`}
                >
                  <div className="font-semibold">No — retain payment</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Finance will issue GST invoice
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setRefundEligible("yes")}
                  className={`rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                    refundEligible === "yes"
                      ? "border-blue-500 bg-blue-50 ring-1 ring-blue-400"
                      : "bg-white hover:bg-muted/40"
                  }`}
                >
                  <div className="font-semibold">Yes — request refund</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Goes to manager/admin for approval
                  </div>
                </button>
              </div>

              {refundEligible === "yes" && (
                <div className="space-y-2 pt-2 border-t border-blue-200">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Refund amount</Label>
                      <Input
                        type="number"
                        min={0.01}
                        max={totalCollected}
                        step="0.01"
                        value={refundAmount}
                        onChange={(e) => setRefundAmount(e.target.value)}
                        className="h-9"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        Up to {formatCurrency(totalCollected)} (full collected)
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Refund reason</Label>
                      <select
                        value={refundReason}
                        onChange={(e) => setRefundReason(e.target.value)}
                        className="h-9 w-full px-2 rounded-md border bg-background text-sm"
                      >
                        {Object.entries(REFUND_REQUEST_REASON_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      Refund details {refundReason === "other" && <span className="text-destructive">*</span>}
                    </Label>
                    <Textarea
                      value={refundDetails}
                      onChange={(e) => setRefundDetails(e.target.value)}
                      placeholder="Context for the approver (manager/admin)"
                      rows={2}
                      className="text-sm bg-white"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Summary footer */}
          <div className="rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-2">
            <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Cancelling is permanent. To revive this booking you&apos;ll need to create a new one.
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Keep booking
            </Button>
            <Button
              variant="destructive"
              onClick={submit}
              disabled={submitting || !reason || (hasCollectedPayment && refundEligible === null)}
            >
              {submitting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Cancelling…</>
                : "Confirm cancellation"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

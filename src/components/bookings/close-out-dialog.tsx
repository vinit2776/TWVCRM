"use client";

/**
 * CloseOutDialog — completes a booking that was never checked in or out on its
 * day. Replaces Check In / Check Out for past-dated bookings.
 *
 * It is a sanctioned exception, not a gate: it always goes through, and records
 * why and on whose watch so the Staff exceptions page can show where the
 * process breaks. The standard path is shown at the top so the person taking
 * the exception knows what it was.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Flag } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  BOOKING_LATE_CLOSE_OUT,
  PROCESS_DEVIATIONS,
  OTHER_COMMENT_MIN_LENGTH,
} from "@/lib/process-registry";

interface StaffOption { id: string; full_name: string; role: string }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  bookingNumber: string;
  bookingDate: string;
  daysLate: number;
  status: "confirmed" | "checked_in";
  /** Grand total and what is still unpaid, for the "billed as booked" note. */
  grandTotal: number;
  balanceDue: number;
  /** Who made the booking, the default for "who was on duty". */
  bookedById: string | null;
  onClosed: () => void;
}

const def = PROCESS_DEVIATIONS[BOOKING_LATE_CLOSE_OUT];

export function CloseOutDialog({
  open, onOpenChange, bookingId, bookingNumber, bookingDate, daysLate,
  status, grandTotal, balanceDue, bookedById, onClosed,
}: Props) {
  const [outcome, setOutcome] = useState<"used" | "no_show">("used");
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [accountable, setAccountable] = useState<string>(bookedById ?? "");
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || staff.length > 0) return;
    let cancelled = false;
    fetch("/api/users")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json?.data) return;
        setStaff(
          (json.data as Array<StaffOption & { is_active?: boolean }>)
            .filter((u) => u.is_active !== false)
            .map((u) => ({ id: u.id, full_name: u.full_name, role: u.role })),
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, staff.length]);

  useEffect(() => {
    if (open) setAccountable(bookedById ?? "");
  }, [open, bookedById]);

  const needsComment = reason === "other";

  async function submit() {
    if (!reason) { setError("Pick why this wasn't handled on the day"); return; }
    if (needsComment && comment.trim().length < OTHER_COMMENT_MIN_LENGTH) {
      setError(`Say what happened, in at least ${OTHER_COMMENT_MIN_LENGTH} characters`);
      return;
    }
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/bookings/${bookingId}/close-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome,
        reason_code: reason,
        comment: comment.trim(),
        accountable_user_id: accountable || null,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) {
      setError(json.error || "Could not close out this booking");
      return;
    }
    toast.success(outcome === "used" ? "Booking closed out" : "Booking marked as no-show");
    onOpenChange(false);
    onClosed();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Close out {bookingNumber}</DialogTitle>
          <DialogDescription>
            Booked for {formatDate(bookingDate)}, {daysLate} {daysLate === 1 ? "day" : "days"} ago.
            Standard path: {def.standard.toLowerCase()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>What happened?</Label>
            <div className="space-y-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="outcome" checked={outcome === "used"} onChange={() => setOutcome("used")} />
                Customer used the room as booked
              </label>
              {status === "confirmed" && (
                <label className="flex items-center gap-2">
                  <input type="radio" name="outcome" checked={outcome === "no_show"} onChange={() => setOutcome("no_show")} />
                  Customer didn&apos;t come (mark no-show)
                </label>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Why wasn&apos;t it checked in on the day?</Label>
            <Select value={reason} onValueChange={(v) => { setReason(v); setError(null); }}>
              <SelectTrigger><SelectValue placeholder="Pick a reason" /></SelectTrigger>
              <SelectContent>
                {def.reasons.map((r) => (
                  <SelectItem key={r.code} value={r.code}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              rows={2}
              value={comment}
              onChange={(e) => { setComment(e.target.value); setError(null); }}
              placeholder={needsComment ? "What happened? (required)" : "Anything accounts or the manager should know (optional)"}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Who was on duty or allowed this?</Label>
            <Select value={accountable} onValueChange={setAccountable}>
              <SelectTrigger><SelectValue placeholder="Whoever booked it" /></SelectTrigger>
              <SelectContent>
                {staff.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The exception is logged against this person, for coaching, not against whoever closes it.
            </p>
          </div>

          {outcome === "used" ? (
            <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs p-2.5 space-y-1">
              <p>
                Billed as booked: {formatCurrency(grandTotal)}. No overtime is added, and check-in and
                checkout times stay empty.
              </p>
              {balanceDue > 0 ? (
                <p>
                  {formatCurrency(balanceDue)} is still unpaid. It stays in Pending Collection, and the
                  GST invoice follows once the payment is verified.
                </p>
              ) : (
                <p>Paid in full, so it goes straight to the GST invoice queue.</p>
              )}
              <p>Add any extra charges from Add charge on this page first. They can&apos;t be added once it&apos;s closed.</p>
            </div>
          ) : (
            <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs p-2.5">
              Same as No Show: vouchers are revoked and any usage charge waived. A payment already taken is kept.
            </div>
          )}

          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Flag className="h-3 w-3" /> Recorded as a late close-out in Staff exceptions.
          </p>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Back</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {outcome === "used" ? "Close out booking" : "Mark as no-show"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

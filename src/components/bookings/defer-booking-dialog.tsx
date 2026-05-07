"use client";

/**
 * DeferBookingDialog — partial-checkout carry-forward UI.
 *
 * The customer is checked in but leaving early. Staff opens this dialog
 * to:
 *   1. confirm how much time was actually used (auto-computed from
 *      check_in_at, but not used in the math — we go by the customer's
 *      booked duration vs the carry-forward they want)
 *   2. choose how many WHOLE HOURS to carry forward (default = floor of
 *      unused time, but staff can bump up — the "generosity lever")
 *   3. confirm the 30-day expiry (or override)
 *
 * Submits to POST /api/bookings/[id]/defer which atomically checks the
 * booking out AND issues the credit.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Coins } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  bookingNumber: string;
  bookedHours: number;            // booking.duration_hours
  hourlyRate: number;             // booking.hourly_rate
  checkInAt: string | null;       // booking.check_in_at (ISO)
  customerPhone: string;
  locationName: string;
  /** Called after successful defer; parent should refetch booking. */
  onSuccess: () => void;
}

export function DeferBookingDialog({
  open, onOpenChange, bookingId, bookingNumber, bookedHours,
  hourlyRate, checkInAt, customerPhone, locationName, onSuccess,
}: Props) {
  const [hoursToCarry, setHoursToCarry] = useState<number>(0);
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  // Initial fill when the dialog opens — re-derive every time so the
  // "used" number reflects the real-world clock at the moment of opening.
  useEffect(() => {
    if (!open) return;
    const now = new Date();
    const usedHours = checkInAt
      ? Math.max(0, (now.getTime() - new Date(checkInAt).getTime()) / 3_600_000)
      : 0;
    const unused = Math.max(0, bookedHours - usedHours);
    // Default = floor of unused, capped at booked hours, minimum 0
    // (staff can override up — that's the "generosity lever").
    const defaultCarry = Math.max(0, Math.min(bookedHours, Math.floor(unused)));
    setHoursToCarry(defaultCarry);

    // Default expiry = +30 days, formatted for <input type="date">
    const exp = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    setExpiresAt(exp.toISOString().slice(0, 10));
    setNotes("");
  }, [open, checkInAt, bookedHours]);

  // Live preview of "used" so staff can see what the system thinks vs
  // what they're actually crediting. Shown as h:mm to avoid the awkward
  // 2.183333 hours display.
  const now = new Date();
  const usedMs = checkInAt ? Math.max(0, now.getTime() - new Date(checkInAt).getTime()) : 0;
  const usedH = Math.floor(usedMs / 3_600_000);
  const usedM = Math.floor((usedMs % 3_600_000) / 60_000);

  const creditValue = hoursToCarry * hourlyRate;

  const submit = async () => {
    if (!Number.isInteger(hoursToCarry) || hoursToCarry < 1) {
      toast.error("Carry-forward must be a whole number ≥ 1");
      return;
    }
    if (hoursToCarry > bookedHours) {
      toast.error(`Cannot carry forward more than the booked ${bookedHours}h`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/defer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hours_to_carry: hoursToCarry,
          expires_at: expiresAt
            ? new Date(`${expiresAt}T23:59:59+05:30`).toISOString()
            : undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to defer booking");
        return;
      }
      toast.success(
        `${hoursToCarry}h credit issued for ${customerPhone}`,
        { description: `Valid at ${locationName} until ${expiresAt}.` }
      );
      onSuccess();
      onOpenChange(false);
    } catch {
      toast.error("Failed to defer booking");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-600" />
            Defer remaining time
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Booking summary */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Booking</span>
              <span className="font-mono text-xs">{bookingNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Booked</span>
              <span>{bookedHours} hour{bookedHours !== 1 ? "s" : ""}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Time used so far</span>
              <span>{usedH}h {String(usedM).padStart(2, "0")}m</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Centre</span>
              <span>{locationName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Customer phone</span>
              <span className="font-mono">{customerPhone || "— missing —"}</span>
            </div>
          </div>

          {/* Carry-forward — the editable field */}
          <div className="space-y-1.5">
            <Label htmlFor="defer-hours">
              Carry forward (whole hours)
            </Label>
            <Input
              id="defer-hours"
              type="number"
              min={1}
              max={bookedHours}
              step={1}
              value={hoursToCarry}
              onChange={(e) => setHoursToCarry(parseInt(e.target.value) || 0)}
              className="h-9"
            />
            <p className="text-[11px] text-muted-foreground">
              Default = floor of unused time. Bump up if you&apos;d like to be generous —
              fractional time is otherwise forfeited per policy.
            </p>
            {hoursToCarry > 0 && (
              <p className="text-xs text-emerald-700 font-medium">
                Credit value (snapshot at today&apos;s rate): {formatCurrency(creditValue)}
              </p>
            )}
          </div>

          {/* Expiry */}
          <div className="space-y-1.5">
            <Label htmlFor="defer-expires">
              Valid until
            </Label>
            <Input
              id="defer-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
              className="h-9"
            />
            <p className="text-[11px] text-muted-foreground">
              Defaults to 30 days. Floor manager+ can override.
            </p>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="defer-notes">Notes (optional)</Label>
            <Textarea
              id="defer-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Customer returning at 5pm; rounded up by 30min as goodwill"
              rows={2}
              className="text-sm"
            />
          </div>

          <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-[11px] text-blue-900">
            <strong>What happens next:</strong> the booking checks out now,
            and a {hoursToCarry || "—"}h credit is issued against {customerPhone || "the customer's phone"}.
            They can redeem it on any future booking at {locationName} until {expiresAt || "—"}.
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting || hoursToCarry < 1 || !customerPhone}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {submitting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Deferring…</>
                : `Defer & Check Out`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

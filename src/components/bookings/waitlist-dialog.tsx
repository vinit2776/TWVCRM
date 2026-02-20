"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, ListOrdered } from "lucide-react";
import { toast } from "sonner";

export function WaitlistDialog({
  open,
  onOpenChange,
  spaceId,
  bookingDate,
  startTime,
  endTime,
  customerType,
  contractId,
  leadId,
  guestName,
  guestPhone,
  bookerPhone,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  customerType: string;
  contractId?: string;
  leadId?: string;
  guestName?: string;
  guestPhone?: string;
  bookerPhone: string;
  onAdded: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAdd = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bookings/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          space_id: spaceId,
          booking_date: bookingDate,
          start_time: startTime,
          end_time: endTime,
          customer_type: customerType,
          contract_id: contractId,
          lead_id: leadId,
          guest_name: guestName,
          guest_phone: guestPhone,
          booker_phone: bookerPhone,
          notes,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to add to waitlist");
        return;
      }
      toast.success("Added to waitlist. You'll be notified when the slot becomes available.");
      onAdded();
      onOpenChange(false);
    } catch {
      toast.error("Failed to add to waitlist");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ListOrdered className="w-5 h-5" /> Join Waitlist</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
            <p className="font-semibold text-amber-800">This slot is currently booked</p>
            <p className="text-amber-700 mt-1">You&apos;ll be added to the waitlist and notified if the slot becomes available.</p>
          </div>

          <div className="text-sm text-gray-600 space-y-1">
            <p><strong>Date:</strong> {bookingDate}</p>
            <p><strong>Time:</strong> {startTime} – {endTime}</p>
          </div>

          <div>
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Any special requests..." />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleAdd} disabled={loading}>
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Join Waitlist
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

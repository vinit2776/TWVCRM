"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Clock } from "lucide-react";
import { toast } from "sonner";

export function ExtendBookingDialog({
  open,
  onOpenChange,
  bookingId,
  currentEnd,
  hourlyRate,
  onExtended,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  currentEnd: string;
  hourlyRate: number;
  onExtended: () => void;
}) {
  const [newEnd, setNewEnd] = useState(currentEnd.slice(0, 5));
  const [loading, setLoading] = useState(false);

  // Calculate estimated additional cost
  const [ch, cm] = currentEnd.slice(0, 5).split(":").map(Number);
  const [nh, nm] = newEnd.split(":").map(Number);
  const extraHours = Math.max(0, (nh * 60 + nm - ch * 60 - cm) / 60);
  const extraCost = Math.round(extraHours * hourlyRate);

  const handleExtend = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extend", new_end_time: newEnd }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to extend");
        return;
      }
      toast.success(`Booking extended. Additional: ₹${json.extension?.price_difference?.toLocaleString("en-IN") || extraCost}`);
      onExtended();
      onOpenChange(false);
    } catch {
      toast.error("Failed to extend");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Clock className="w-5 h-5" /> Extend Booking</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Current End Time</Label>
            <Input value={currentEnd.slice(0, 5)} disabled className="bg-gray-50" />
          </div>
          <div>
            <Label>New End Time</Label>
            <Input type="time" value={newEnd} onChange={e => setNewEnd(e.target.value)} min={currentEnd.slice(0, 5)} />
          </div>
          {extraHours > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              <p className="font-semibold text-amber-800">Additional {extraHours.toFixed(1)} hour(s)</p>
              <p className="text-amber-700">Estimated extra charge: ₹{extraCost.toLocaleString("en-IN")}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleExtend} disabled={loading || extraHours <= 0}>
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Extend Booking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

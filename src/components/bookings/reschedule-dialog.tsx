"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CalendarClock } from "lucide-react";
import { toast } from "sonner";

export function RescheduleDialog({
  open,
  onOpenChange,
  bookingId,
  currentDate,
  currentStart,
  currentEnd,
  onRescheduled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  currentDate: string;
  currentStart: string;
  currentEnd: string;
  onRescheduled: () => void;
}) {
  const [newDate, setNewDate] = useState(currentDate);
  const [newStart, setNewStart] = useState(currentStart.slice(0, 5));
  const [newEnd, setNewEnd] = useState(currentEnd.slice(0, 5));
  const [loading, setLoading] = useState(false);

  const handleReschedule = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reschedule", new_date: newDate, new_start_time: newStart, new_end_time: newEnd }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to reschedule");
        return;
      }
      toast.success("Booking rescheduled successfully");
      onRescheduled();
      onOpenChange(false);
    } catch {
      toast.error("Failed to reschedule");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarClock className="w-5 h-5" /> Reschedule Booking</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>New Date</Label>
            <Input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start Time</Label>
              <Input type="time" value={newStart} onChange={e => setNewStart(e.target.value)} />
            </div>
            <div>
              <Label>End Time</Label>
              <Input type="time" value={newEnd} onChange={e => setNewEnd(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-gray-500">
            Current: {currentDate} · {currentStart.slice(0, 5)} – {currentEnd.slice(0, 5)}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleReschedule} disabled={loading}>
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Reschedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

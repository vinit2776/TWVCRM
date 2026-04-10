"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Clock, IndianRupee, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { WaiverRequestDialog } from "./waiver-request-dialog";

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
  const [extended, setExtended] = useState(false);
  const [priceDiff, setPriceDiff] = useState<number | null>(null);
  const [waiverOpen, setWaiverOpen] = useState(false);

  // Calculate estimated additional cost
  const [ch, cm] = currentEnd.slice(0, 5).split(":").map(Number);
  const [nh, nm] = (newEnd || "00:00").split(":").map(Number);
  const extraMinutes = Math.max(0, nh * 60 + nm - ch * 60 - cm);
  const extraHours = extraMinutes / 60;
  const extraCost = Math.round(extraHours * hourlyRate);

  const formatHours = (h: number) => {
    const wh = Math.floor(h);
    const wm = Math.round((h - wh) * 60);
    if (wh === 0) return `${wm}m`;
    if (wm === 0) return `${wh}h 00m`;
    return `${wh}h ${String(wm).padStart(2, "0")}m`;
  };

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
      const diff = json.extension?.price_difference ?? extraCost;
      setPriceDiff(diff);
      setExtended(true);
      if (diff > 0) {
        toast.success(`Booking extended. Differential charge: ₹${diff.toLocaleString("en-IN")} — collect payment or request waiver.`);
      } else {
        toast.success("Booking extended.");
        onExtended();
        onOpenChange(false);
      }
    } catch {
      toast.error("Failed to extend");
    } finally {
      setLoading(false);
    }
  };

  const handleCollectAndClose = () => {
    onExtended();
    onOpenChange(false);
  };

  const handleWaiverApproved = () => {
    onExtended();
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Clock className="w-5 h-5" /> Extend Booking</DialogTitle>
          </DialogHeader>

          {!extended ? (
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
                  <p className="font-semibold text-amber-800">Additional {formatHours(extraHours)}</p>
                  <p className="text-amber-700">Differential charge: ₹{extraCost.toLocaleString("en-IN")}</p>
                  <p className="text-amber-600 text-xs mt-1">Payment will be required after extension.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                <p className="font-semibold text-blue-800">Booking extended successfully</p>
                {priceDiff && priceDiff > 0 && (
                  <p className="text-blue-700 mt-1">
                    Differential charge of <strong>₹{priceDiff.toLocaleString("en-IN")}</strong> needs to be collected.
                  </p>
                )}
              </div>
              <p className="text-sm text-muted-foreground">Choose how to proceed with the extra charge:</p>
            </div>
          )}

          <DialogFooter className={extended ? "flex-col gap-2 sm:flex-col" : ""}>
            {!extended ? (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button onClick={handleExtend} disabled={loading || extraHours <= 0}>
                  {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Extend Booking
                </Button>
              </>
            ) : (
              <>
                <Button className="w-full" onClick={handleCollectAndClose}>
                  <IndianRupee className="w-4 h-4 mr-2" />
                  Collect Differential Payment
                </Button>
                <Button variant="outline" className="w-full border-amber-300 text-amber-700 hover:bg-amber-50" onClick={() => setWaiverOpen(true)}>
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Request Manager Waiver
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {priceDiff && priceDiff > 0 && (
        <WaiverRequestDialog
          open={waiverOpen}
          onOpenChange={setWaiverOpen}
          bookingId={bookingId}
          waiverType="extension"
          waiverAmount={priceDiff}
          onApproved={handleWaiverApproved}
        />
      )}
    </>
  );
}

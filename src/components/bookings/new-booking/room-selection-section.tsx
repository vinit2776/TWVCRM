"use client";

import { memo } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useLocations } from "@/hooks/use-locations";
import { formatCurrency } from "@/lib/utils";
import { useBookingForm } from "./booking-form-context";

export const RoomSelectionSection = memo(function RoomSelectionSection() {
  const {
    locationId, setLocationId, spaces, spaceId, setSpaceId, setSelectedSpace,
    bookingDate, setBookingDate, selectedSpace, numAttendees, setNumAttendees,
    numSeats, setNumSeats, availableSlots, availLoading, isDayPass,
    dayPassUsed, effectiveRate, availabilityWindows, startTime, setStartTime,
    endTime, setEndTime, minBookingMin, slotStepMin, formatTime12, formatDuration,
  } = useBookingForm();
  const { locations } = useLocations();

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">1. Select Room</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>Location *</Label>
            <Select value={locationId} onValueChange={(val) => { setLocationId(val); setSpaceId(""); setSelectedSpace(null); }}>
              <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
              <SelectContent>
                {locations.map(loc => <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Room *</Label>
            <Select value={spaceId} onValueChange={setSpaceId} disabled={!locationId}>
              <SelectTrigger><SelectValue placeholder="Select room" /></SelectTrigger>
              <SelectContent>
                {spaces.map(s => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.capacity} seats, {
                      s.pricing_model === "daily"
                        ? `${formatCurrency(Number(s.daily_rate ?? 0))}/day`
                        : `${formatCurrency(s.hourly_rate)}/hr`
                    })
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Date *</Label>
            <Input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>No. of Attendees</Label>
            <Input
              type="number"
              min="1"
              placeholder={selectedSpace ? `Up to ${selectedSpace.capacity}` : "e.g. 4"}
              value={numAttendees}
              onChange={(e) => setNumAttendees(e.target.value)}
            />
            {numAttendees && selectedSpace && parseInt(numAttendees, 10) > selectedSpace.capacity && (
              <p className="text-xs text-amber-600 flex items-center gap-1">
                ⚠ Exceeds room capacity of {selectedSpace.capacity} — you can still book, but seating may be tight.
              </p>
            )}
            {numAttendees && parseInt(numAttendees, 10) >= 1 && (
              <p className="text-xs text-muted-foreground">
                {Math.ceil(parseInt(numAttendees, 10) / 2)} WiFi voucher{Math.ceil(parseInt(numAttendees, 10) / 2) !== 1 ? "s" : ""} will be issued (1 per 2 devices)
              </p>
            )}
          </div>
        </div>

        {/* Day-pass capacity */}
        {spaceId && bookingDate && isDayPass && selectedSpace && (
          <div className="pt-2 space-y-3">
            <div className="rounded-lg border bg-muted/20 p-3 text-sm">
              {(() => {
                const cap = selectedSpace.capacity || 1;
                const remaining = Math.max(0, cap - dayPassUsed);
                const exhausted = remaining === 0;
                return (
                  <div className="flex items-start gap-2">
                    <div className={`mt-0.5 h-2 w-2 rounded-full ${exhausted ? "bg-red-500" : "bg-emerald-500"}`} />
                    <div>
                      <div className="font-medium">
                        {exhausted ? "All day passes booked" : `${remaining} of ${cap} day passes available`} for this date
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Day passes don&apos;t use the slot grid — any seat at this location works.
                        Hourly meeting/conference rooms are unaffected.
                      </p>
                    </div>
                  </div>
                );
              })()}
            </div>
            {/* Seat count selector */}
            <div className="flex items-center gap-3">
              <Label className="text-sm shrink-0">No. of Seats</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button" variant="outline" size="sm"
                  className="h-8 w-8 p-0 text-base"
                  onClick={() => setNumSeats(s => Math.max(1, s - 1))}
                  disabled={numSeats <= 1}
                >−</Button>
                <span className="w-8 text-center font-medium tabular-nums">{numSeats}</span>
                <Button
                  type="button" variant="outline" size="sm"
                  className="h-8 w-8 p-0 text-base"
                  onClick={() => setNumSeats(s => Math.min(s + 1, selectedSpace?.capacity || 99))}
                >+</Button>
              </div>
              {numSeats > 1 && (
                <p className="text-xs text-muted-foreground">
                  {numSeats} × {formatCurrency(effectiveRate)} = <span className="font-medium text-foreground">{formatCurrency(effectiveRate * numSeats)}</span>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Hourly slot availability */}
        {spaceId && bookingDate && !isDayPass && (
          <div className="pt-2">
            <div className="flex items-center gap-2 mb-2">
              <Label className="text-sm text-muted-foreground">Available Slots</Label>
              {availLoading && <Loader2 className="h-3 w-3 animate-spin" />}
            </div>
            {availableSlots.length === 0 ? (
              <p className="text-sm text-muted-foreground">{availLoading ? "Loading..." : "No slots available or room is closed on this day."}</p>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {availabilityWindows.map((window, i) => {
                    const [ws, wm] = window.start_time.split(":").map(Number);
                    const [we, wme] = window.end_time.split(":").map(Number);
                    const windowDuration = (we * 60 + wme) - (ws * 60 + wm);
                    const durationLabel = formatDuration(windowDuration / 60);
                    return (
                      <Badge
                        key={i}
                        variant="outline"
                        className="text-xs bg-green-50 text-green-700 cursor-pointer hover:bg-green-100"
                        onClick={() => {
                          setStartTime(window.start_time);
                          const autoEndMin = Math.min(ws * 60 + wm + minBookingMin, we * 60 + wme);
                          const autoEndH = Math.floor(autoEndMin / 60);
                          const autoEndM = autoEndMin % 60;
                          setEndTime(`${String(autoEndH).padStart(2, "0")}:${String(autoEndM).padStart(2, "0")}`);
                        }}
                      >
                        {formatTime12(window.start_time)} – {formatTime12(window.end_time)} ({durationLabel})
                      </Badge>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Min booking: {minBookingMin} min, then {slotStepMin}-min increments. Click a window to auto-fill times.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});

"use client";

import { memo } from "react";
import { Clock, ListOrdered } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useBookingForm } from "./booking-form-context";

export const TimeSelectionSection = memo(function TimeSelectionSection() {
  const {
    isDayPass, selectedSpace, startTime, setStartTime, endTime, setEndTime,
    durationHours, timeOptions, endTimeOptions, slotConflict,
    bookerPhone, setWaitlistDialogOpen, formatTime12, formatDuration,
  } = useBookingForm();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          2. {isDayPass ? "Day Pass Coverage" : "Select Time"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isDayPass ? (
          <div className="rounded-lg border bg-muted/20 p-3 flex items-start gap-3">
            <Clock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-sm space-y-0.5">
              <div>
                Day pass covers the centre&apos;s operating hours
                {startTime && endTime
                  ? <> — <span className="font-medium">{formatTime12(startTime)} to {formatTime12(endTime)}</span></>
                  : null}
                .
              </div>
              <p className="text-xs text-muted-foreground">
                The customer is charged a flat day rate. Extras (extended time, printer, F&amp;B) can be added at check-out.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Start Time *</Label>
              <Select value={startTime} onValueChange={(val) => { setStartTime(val); if (endTime && val >= endTime) setEndTime(""); }}>
                <SelectTrigger><SelectValue placeholder="Start time" /></SelectTrigger>
                <SelectContent>
                  {timeOptions.map(t => <SelectItem key={t} value={t}>{formatTime12(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>End Time *</Label>
              <Select value={endTime} onValueChange={setEndTime} disabled={!startTime}>
                <SelectTrigger><SelectValue placeholder="End time" /></SelectTrigger>
                <SelectContent>
                  {endTimeOptions.map(t => <SelectItem key={t} value={t}>{formatTime12(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Duration</Label>
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border bg-muted/30">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{formatDuration(durationHours)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Slot conflict — Waitlist prompt */}
        {slotConflict && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListOrdered className="h-4 w-4 text-amber-600" />
                <p className="text-sm text-amber-800 font-medium">This time slot is not available</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-amber-700 border-amber-300 hover:bg-amber-100"
                onClick={() => setWaitlistDialogOpen(true)}
                disabled={!bookerPhone.trim()}
              >
                Join Waitlist
              </Button>
            </div>
            <p className="text-xs text-amber-700 mt-1">
              You can join the waitlist and be notified when the slot becomes available.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

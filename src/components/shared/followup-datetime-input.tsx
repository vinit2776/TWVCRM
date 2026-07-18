"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Follow-ups only make sense during working hours, in half-hour slots — a bare
// <input type="datetime-local"> lets the browser silently fill the time segment
// with 00:00 when only the date is touched via the calendar picker, producing
// midnight follow-ups nobody intended. A native <input type="time"> fixes the
// silent-default problem but renders as an OS spinner, not a clickable list, and
// its picker UI is unreliable across browsers — so the time side is a real
// dropdown of fixed 30-min slots (every option is inherently valid) alongside a
// plain date input.
const TIME_OPTIONS: { value: string; label: string }[] = (() => {
  const opts: { value: string; label: string }[] = [];
  for (let minutes = 9 * 60; minutes <= 20 * 60; minutes += 30) {
    const h24 = Math.floor(minutes / 60);
    const m = minutes % 60;
    const value = `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const ampm = h24 < 12 ? "AM" : "PM";
    opts.push({ value, label: `${h12}:${String(m).padStart(2, "0")} ${ampm}` });
  }
  return opts;
})();

export type FollowUpDateTimeStatus = "empty" | "incomplete" | "valid";

interface FollowUpDateTimeInputProps {
  /** Combined "yyyy-MM-ddTHH:mm" value, or "" when unset. Mirrors the shape callers already store for follow_up_date. */
  value: string;
  onChange: (value: string) => void;
  /** Fires whenever the combined value would be "empty" (nothing picked), "incomplete" (only one side picked), or "valid". */
  onStatusChange?: (status: FollowUpDateTimeStatus) => void;
  /** Floors the date picker, e.g. today's date for reschedule flows. */
  minDate?: string;
  className?: string;
}

export function FollowUpDateTimeInput({
  value,
  onChange,
  onStatusChange,
  minDate,
  className,
}: FollowUpDateTimeInputProps) {
  const [datePart, setDatePart] = useState("");
  const [timePart, setTimePart] = useState("");
  // Tracks the last value *we* echoed via onChange, so the sync effect below can tell
  // "parent passed our own change back down" (ignore — internal date/time state is
  // already correct) apart from a genuine external reset/prefill.
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    if (value) {
      const [d, t] = value.split("T");
      setDatePart(d ?? "");
      setTimePart(t ? t.slice(0, 5) : "");
    } else {
      setDatePart("");
      setTimePart("");
    }
    lastEmitted.current = value;
  }, [value]);

  const emit = (nextDate: string, nextTime: string) => {
    const complete = !!nextDate && !!nextTime;
    const combined = complete ? `${nextDate}T${nextTime}` : "";

    lastEmitted.current = combined;
    onChange(combined);
    onStatusChange?.(complete ? "valid" : nextDate || nextTime ? "incomplete" : "empty");
  };

  return (
    <div className={`flex gap-2 ${className ?? ""}`}>
      <Input
        type="date"
        value={datePart}
        min={minDate}
        onChange={(e) => {
          setDatePart(e.target.value);
          emit(e.target.value, timePart);
        }}
      />
      <Select
        value={timePart}
        onValueChange={(val) => {
          setTimePart(val);
          emit(datePart, val);
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select time" />
        </SelectTrigger>
        <SelectContent>
          {TIME_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

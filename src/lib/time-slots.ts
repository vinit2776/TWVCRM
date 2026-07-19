/**
 * 30-minute time slots from 9:00 AM to 10:00 PM, for dropdown time pickers
 * that pair with a plain date input instead of a native datetime-local
 * control (whose free-scroll time picker is fiddly on mobile).
 */
export interface TimeSlotOption {
  value: string; // "HH:mm", 24-hour, matches the <input type="time"> / datetime-local wire format
  label: string; // "9:00 AM"
}

export const BUSINESS_HOURS_TIME_SLOTS: TimeSlotOption[] = (() => {
  const slots: TimeSlotOption[] = [];
  for (let totalMinutes = 9 * 60; totalMinutes <= 22 * 60; totalMinutes += 30) {
    const hour24 = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const value = `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const period = hour24 < 12 ? "AM" : "PM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const label = `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
    slots.push({ value, label });
  }
  return slots;
})();

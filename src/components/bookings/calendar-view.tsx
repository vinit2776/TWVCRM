"use client";

import { useEffect, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BOOKING_STATUS_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface CalendarBooking {
  id: string;
  booking_number: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  customer_type: string;
  guest_name?: string;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  contract?: { contract_number: string } | null;
}

interface CalendarSpace {
  id: string;
  name: string;
  capacity: number;
  operating_hours: Record<string, { open: string; close: string; is_open: boolean }>;
}

interface CalendarData {
  space: CalendarSpace;
  bookings: CalendarBooking[];
}

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7 AM to 8 PM

function formatHour(h: number) {
  return h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
}

export function CalendarView({
  locations,
  onBookingClick,
  onSlotClick,
}: {
  locations: { id: string; name: string }[];
  onBookingClick: (id: string) => void;
  onSlotClick: (spaceId: string, date: string, time: string) => void;
}) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [locationId, setLocationId] = useState(locations[0]?.id || "");
  const [data, setData] = useState<CalendarData[]>([]);
  const [loading, setLoading] = useState(false);

  const dateStr = currentDate.toISOString().split("T")[0];

  const fetchCalendar = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/bookings/calendar?date_from=${dateStr}&date_to=${dateStr}&location_id=${locationId}`);
      const json = await res.json();
      if (json.data) setData(json.data);
    } catch (e) {
      console.error("Calendar fetch failed:", e);
    } finally {
      setLoading(false);
    }
  }, [dateStr, locationId]);

  useEffect(() => { fetchCalendar(); }, [fetchCalendar]);

  const prevDay = () => setCurrentDate(d => { const n = new Date(d); n.setDate(n.getDate() - 1); return n; });
  const nextDay = () => setCurrentDate(d => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; });
  const today = () => setCurrentDate(new Date());

  const getBookingsForSlot = (bookings: CalendarBooking[], hour: number) => {
    return bookings.filter(b => {
      const bStart = parseInt(b.start_time.split(":")[0]);
      const bEnd = parseInt(b.end_time.split(":")[0]);
      return bStart <= hour && bEnd > hour;
    });
  };

  const isStartHour = (b: CalendarBooking, hour: number) => parseInt(b.start_time.split(":")[0]) === hour;
  const getSpan = (b: CalendarBooking) => {
    const s = parseInt(b.start_time.split(":")[0]);
    const e = parseInt(b.end_time.split(":")[0]);
    return e - s;
  };

  const getCustomerName = (b: CalendarBooking) => {
    if (b.lead) return `${b.lead.first_name} ${b.lead.last_name}`;
    return b.guest_name || b.booking_number;
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={prevDay}><ChevronLeft className="w-4 h-4" /></Button>
          <Button variant="outline" size="sm" onClick={today}>Today</Button>
          <Button variant="outline" size="icon" onClick={nextDay}><ChevronRight className="w-4 h-4" /></Button>
          <span className="font-semibold text-lg ml-2">
            {currentDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </span>
        </div>
        <Select value={locationId} onValueChange={setLocationId}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Location" /></SelectTrigger>
          <SelectContent>
            {locations.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
      ) : data.length === 0 ? (
        <div className="text-center py-16 text-gray-500">No rooms found for this location</div>
      ) : (
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-gray-50">
                <th className="border p-2 text-left text-sm font-semibold w-32 sticky left-0 bg-gray-50 z-10">Room</th>
                {HOURS.map(h => (
                  <th key={h} className="border p-1 text-center text-xs font-medium text-gray-500 min-w-[60px]">
                    {formatHour(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map(({ space, bookings }) => (
                <tr key={space.id} className="hover:bg-gray-50/50">
                  <td className="border p-2 text-sm font-medium sticky left-0 bg-white z-10">
                    <div>{space.name}</div>
                    <div className="text-xs text-gray-400">{space.capacity} seats</div>
                  </td>
                  {HOURS.map(hour => {
                    const slotBookings = getBookingsForSlot(bookings, hour);
                    const startBooking = slotBookings.find(b => isStartHour(b, hour));

                    if (slotBookings.length > 0 && !startBooking) return null; // Part of a spanned cell

                    if (startBooking) {
                      const span = getSpan(startBooking);
                      const statusColor = BOOKING_STATUS_COLORS[startBooking.status] || "bg-gray-200";
                      return (
                        <td
                          key={hour}
                          colSpan={Math.min(span, HOURS.length - HOURS.indexOf(hour))}
                          className="border p-0"
                        >
                          <button
                            onClick={() => onBookingClick(startBooking.id)}
                            className={cn("w-full h-full p-1 text-xs text-left rounded-sm hover:opacity-80 min-h-[40px]", statusColor)}
                          >
                            <div className="font-semibold truncate">{getCustomerName(startBooking)}</div>
                            <div className="truncate opacity-75">{startBooking.start_time.slice(0, 5)}–{startBooking.end_time.slice(0, 5)}</div>
                          </button>
                        </td>
                      );
                    }

                    return (
                      <td key={hour} className="border p-0">
                        <button
                          onClick={() => onSlotClick(space.id, dateStr, `${hour.toString().padStart(2, "0")}:00`)}
                          className="w-full h-full min-h-[40px] hover:bg-emerald-50 transition-colors cursor-pointer"
                          title={`Book ${space.name} at ${formatHour(hour)}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

export function BookingCountdown({ bookingDate, startTime }: { bookingDate: string; startTime: string }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    const update = () => {
      const [h, m] = startTime.split(":").map(Number);
      const target = new Date(bookingDate + "T00:00:00");
      target.setHours(h, m, 0, 0);
      const now = new Date();
      const diff = target.getTime() - now.getTime();

      if (diff <= 0) {
        setTimeLeft("Now");
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      if (hours > 0) {
        setTimeLeft(`${hours}h ${minutes}m`);
      } else if (minutes > 0) {
        setTimeLeft(`${minutes}m ${seconds}s`);
      } else {
        setTimeLeft(`${seconds}s`);
      }
    };

    update();
    // Tick every 10s instead of 1s. With potentially dozens of countdowns on a
    // bookings list, 1s updates triggered 50+ renders/sec. The display format
    // is minute-granular except in the final minute, so 10s is plenty accurate.
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, [bookingDate, startTime]);

  if (!timeLeft || timeLeft === "Now") return null;

  return (
    <div className="inline-flex items-center gap-1.5 bg-[#015E65]/10 text-[#015E65] px-3 py-1 rounded-full text-sm font-medium">
      <Clock className="w-3.5 h-3.5" />
      <span>Next in {timeLeft}</span>
    </div>
  );
}

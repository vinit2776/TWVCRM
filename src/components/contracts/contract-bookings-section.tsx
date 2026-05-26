"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, CalendarDays, ChevronDown, ChevronRight } from "lucide-react";

interface BookingRow {
  id: string;
  booking_number: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  duration_hours: number;
  status: string;
  payment_status: string;
  space: { name: string } | null;
}

interface MonthGroup {
  key: string;           // "2026-05"
  label: string;         // "May 2026"
  bookings: BookingRow[];
  totalHours: number;
}

function formatTime(t: string) {
  const [h, m] = t.split(":");
  const hour = parseInt(h);
  return `${hour > 12 ? hour - 12 : hour === 0 ? 12 : hour}:${m} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatDate(d: string) {
  return new Date(d + "T00:00:00+05:30").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });
}

function PaymentBadge({ status, bookingStatus }: { status: string; bookingStatus: string }) {
  if (bookingStatus === "cancelled" || bookingStatus === "no_show") {
    return <Badge variant="secondary" className="text-xs">{bookingStatus === "cancelled" ? "Cancelled" : "No Show"}</Badge>;
  }
  switch (status) {
    case "waived":
      return <Badge className="text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border border-emerald-200">Quota</Badge>;
    case "posted_to_bill":
      return <Badge className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-100 border border-blue-200">Billed</Badge>;
    case "paid":
      return <Badge className="text-xs bg-green-100 text-green-700 hover:bg-green-100 border border-green-200">Paid</Badge>;
    case "pending":
      return <Badge className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">Pending</Badge>;
    default:
      return <Badge variant="secondary" className="text-xs capitalize">{status}</Badge>;
  }
}

function BookingStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "checked_out":
      return <Badge className="text-xs bg-slate-100 text-slate-600 hover:bg-slate-100 border border-slate-200">Checked Out</Badge>;
    case "checked_in":
      return <Badge className="text-xs bg-teal-100 text-teal-700 hover:bg-teal-100 border border-teal-200">Checked In</Badge>;
    case "confirmed":
      return <Badge className="text-xs bg-sky-100 text-sky-700 hover:bg-sky-100 border border-sky-200">Confirmed</Badge>;
    case "cancelled":
      return <Badge variant="secondary" className="text-xs">Cancelled</Badge>;
    case "no_show":
      return <Badge className="text-xs bg-red-100 text-red-700 hover:bg-red-100 border border-red-200">No Show</Badge>;
    default:
      return <Badge variant="secondary" className="text-xs capitalize">{status}</Badge>;
  }
}

export function ContractBookingsSection({ contractId }: { contractId: string }) {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from("bookings")
        .select("id, booking_number, booking_date, start_time, end_time, duration_hours, status, payment_status, space:spaces!bookings_space_id_fkey(name)")
        .eq("contract_id", contractId)
        .order("booking_date", { ascending: false });
      if (!cancelled) {
        setBookings((data ?? []) as unknown as BookingRow[]);
        setLoading(false);
        // Auto-open the most recent month
        if (data && data.length > 0) {
          const first = (data[0] as unknown as BookingRow).booking_date.substring(0, 7);
          setOpenMonths(new Set([first]));
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group by calendar month (YYYY-MM), newest first
  const monthGroups = useMemo<MonthGroup[]>(() => {
    const map = new Map<string, BookingRow[]>();
    for (const b of bookings) {
      const key = b.booking_date.substring(0, 7); // "2026-05"
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0])) // newest first
      .map(([key, rows]) => {
        const [yr, mo] = key.split("-").map(Number);
        const label = new Date(yr, mo - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
        const totalHours = rows
          .filter(r => r.status !== "cancelled" && r.status !== "no_show")
          .reduce((s, r) => s + Number(r.duration_hours), 0);
        return { key, label, bookings: rows, totalHours };
      });
  }, [bookings]);

  function toggleMonth(key: string) {
    setOpenMonths(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const totalHoursAll = useMemo(
    () => bookings.filter(b => b.status !== "cancelled" && b.status !== "no_show").reduce((s, b) => s + Number(b.duration_hours), 0),
    [bookings]
  );
  const activeCount = bookings.filter(b => b.status !== "cancelled" && b.status !== "no_show").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            Meeting Room Bookings
          </CardTitle>
          {!loading && bookings.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{activeCount} booking{activeCount !== 1 ? "s" : ""}</span>
              <span>·</span>
              <span>{totalHoursAll} hr{totalHoursAll !== 1 ? "s" : ""} total</span>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm">Loading bookings…</span>
          </div>
        ) : bookings.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No bookings found for this contract.
          </p>
        ) : (
          <div className="space-y-2">
            {monthGroups.map((group) => {
              const isOpen = openMonths.has(group.key);
              const billedCount = group.bookings.filter(b => b.payment_status === "posted_to_bill").length;
              const quotaCount  = group.bookings.filter(b => b.payment_status === "waived").length;
              const activeInMonth = group.bookings.filter(b => b.status !== "cancelled" && b.status !== "no_show").length;

              return (
                <div key={group.key} className="border border-border rounded-lg overflow-hidden">
                  {/* Month header row — clickable */}
                  <button
                    onClick={() => toggleMonth(group.key)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      {isOpen
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      }
                      <span className="font-medium text-sm">{group.label}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{activeInMonth} booking{activeInMonth !== 1 ? "s" : ""}</span>
                      <span>·</span>
                      <span className="font-medium text-foreground">{group.totalHours} hr{group.totalHours !== 1 ? "s" : ""}</span>
                      {quotaCount > 0 && (
                        <Badge className="text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border border-emerald-200">
                          {quotaCount} quota
                        </Badge>
                      )}
                      {billedCount > 0 && (
                        <Badge className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-100 border border-blue-200">
                          {billedCount} billed
                        </Badge>
                      )}
                    </div>
                  </button>

                  {/* Expanded booking rows */}
                  {isOpen && (
                    <div className="divide-y divide-border">
                      {/* Table header */}
                      <div className="grid grid-cols-[1.5fr_1fr_0.7fr_0.9fr_0.9fr] gap-2 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        <span>Booking</span>
                        <span>Date / Time</span>
                        <span className="text-right">Hrs</span>
                        <span className="text-center">Status</span>
                        <span className="text-center">Billing</span>
                      </div>

                      {group.bookings.map((b) => (
                        <div
                          key={b.id}
                          className="grid grid-cols-[1.5fr_1fr_0.7fr_0.9fr_0.9fr] gap-2 items-center px-4 py-2.5 text-sm hover:bg-muted/20 transition-colors"
                        >
                          {/* Booking number + space */}
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <Link
                              href={`/bookings/${b.booking_number}`}
                              className="font-mono text-xs font-semibold text-[#015E65] hover:underline truncate"
                            >
                              {b.booking_number}
                            </Link>
                            {b.space?.name && (
                              <span className="text-xs text-muted-foreground truncate">{b.space.name}</span>
                            )}
                          </div>

                          {/* Date / time */}
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs">{formatDate(b.booking_date)}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatTime(b.start_time)} – {formatTime(b.end_time)}
                            </span>
                          </div>

                          {/* Hours */}
                          <div className="text-right font-medium text-sm">
                            {b.status === "cancelled" || b.status === "no_show"
                              ? <span className="text-muted-foreground">—</span>
                              : <>{Number(b.duration_hours)} hr{Number(b.duration_hours) !== 1 ? "s" : ""}</>
                            }
                          </div>

                          {/* Booking status */}
                          <div className="flex justify-center">
                            <BookingStatusBadge status={b.status} />
                          </div>

                          {/* Payment / quota status */}
                          <div className="flex justify-center">
                            <PaymentBadge status={b.payment_status} bookingStatus={b.status} />
                          </div>
                        </div>
                      ))}

                      {/* Month subtotal */}
                      {group.totalHours > 0 && (
                        <div className="grid grid-cols-[1.5fr_1fr_0.7fr_0.9fr_0.9fr] gap-2 px-4 py-2 bg-muted/30 text-xs font-semibold text-muted-foreground">
                          <span className="col-span-2 text-right">Month total</span>
                          <span className="text-right text-foreground">{group.totalHours} hr{group.totalHours !== 1 ? "s" : ""}</span>
                          <span />
                          <span />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
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
  check_in_at: string | null;
  check_out_at: string | null;
  space: { name: string } | null;
}

interface ChargeRow {
  id: string;
  booking_id: string;
  status: string;
  quantity: number | null;
  total: number | null;
  unit_price: number | null;
  total_with_gst: number | null;
  booking_charge_kind: string | null;
}

/** Label for a pending (non-waived) charge pill, by origin. Historical
 *  rows only (quota_overage/overtime, from before the pooled-usage
 *  redesign) carry their own kind per row and render as-is; a
 *  'pooled_usage' charge is split into Usage/Extra by splitPooledCharge
 *  below instead of using this directly. */
function chargeLabel(kind: string | null): string {
  if (kind === "overtime") return "Extra";
  return "Usage";
}

/** Actual duration rounded UP to the next whole hour — matches the
 *  backend's checkout-time rounding (roundedActualHours in
 *  bookings/[id]/route.ts), so "hours beyond the booked slot" here lines
 *  up with what was actually pooled against quota. */
function actualHoursCeil(checkInAt: string, checkOutAt: string): number {
  const ms = new Date(checkOutAt).getTime() - new Date(checkInAt).getTime();
  return Math.ceil(Math.max(0, ms) / 3600000);
}

interface ChargeSplit {
  label: string;
  amount: number;
  /** Hours that fed this part's amount — shown above the pill so staff
   *  can see what the ₹ figure assumes, not just the total. */
  hours: number;
}

/** Splits a single pooled_usage charge into "Usage" (within the booked
 *  hours) and "Extra" (checkout ran past the booked end time) for
 *  display — Model B bills both in one row, but staff expect the same
 *  Usage/Extra breakdown the old two-row model showed. Purely a
 *  rendering split, proportional by hour count, so the parts always sum
 *  back to the row's real total_with_gst. */
function splitPooledCharge(booking: BookingRow, charge: ChargeRow): ChargeSplit[] {
  const totalWithGst = Number(charge.total_with_gst ?? 0);
  const quantity = Number(charge.quantity ?? 0);
  if (charge.booking_charge_kind !== "pooled_usage") {
    return [{ label: chargeLabel(charge.booking_charge_kind), amount: totalWithGst, hours: quantity }];
  }
  const unitPrice = Number(charge.unit_price ?? 0);
  const billedHours = unitPrice > 0 ? Math.round(Number(charge.total ?? 0) / unitPrice) : 0;
  if (billedHours === 0 || !booking.check_in_at || !booking.check_out_at) {
    return [{ label: "Usage", amount: totalWithGst, hours: quantity }];
  }
  const extraHoursNeeded = Math.max(
    0,
    actualHoursCeil(booking.check_in_at, booking.check_out_at) - Number(booking.duration_hours)
  );
  const extraBilled = Math.min(billedHours, extraHoursNeeded);
  if (extraBilled === 0) {
    return [{ label: "Usage", amount: totalWithGst, hours: billedHours }];
  }
  const usageBilled = billedHours - extraBilled;
  const extraAmount = Math.round((totalWithGst * extraBilled) / billedHours);
  return [
    ...(usageBilled > 0 ? [{ label: "Usage", amount: totalWithGst - extraAmount, hours: usageBilled }] : []),
    { label: "Extra", amount: extraAmount, hours: extraBilled },
  ];
}

interface MonthGroup {
  key: string;           // "2026-05"
  label: string;         // "May 2026"
  bookings: BookingRow[];
  bookedHoursTotal: number;
  actualHoursTotal: number;
  pendingTotal: number;
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

/** Actual duration in hours between two ISO timestamps, one decimal place. */
function actualHours(checkInAt: string, checkOutAt: string): number {
  const ms = new Date(checkOutAt).getTime() - new Date(checkInAt).getTime();
  return Math.round((ms / 3600000) * 10) / 10;
}

function formatHours(h: number): string {
  return `${h % 1 === 0 ? h : h.toFixed(1)} hr${h === 1 ? "" : "s"}`;
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

/** Billing badges for a booking, driven by its actual linked usage_charges
 *  (Model B — one pooled-usage charge per checked-out booking) rather than
 *  booking.payment_status, which is always "posted_to_bill" for a
 *  contract-holder booking regardless of whether the charge was free or
 *  paid — see the pooled-usage redesign notes. */
interface BadgePart {
  key: string;
  label: string;
  amount: number;
  hours: number;
  waived: boolean;
  quotaFree: boolean;
}

function billingParts(booking: BookingRow, charges: ChargeRow[]): BadgePart[] {
  return charges.flatMap((c): BadgePart[] => {
    const amount = Number(c.total_with_gst ?? 0);
    if (c.status === "waived" && amount === 0) {
      return [{
        key: c.id,
        label: "Quota free",
        amount: 0,
        hours: Number(c.quantity ?? 0),
        waived: true,
        quotaFree: true,
      }];
    }
    return splitPooledCharge(booking, c).map((part, i) => ({
      key: `${c.id}-${i}`,
      label: part.label,
      amount: part.amount,
      hours: part.hours,
      waived: c.status === "waived",
      quotaFree: false,
    }));
  });
}

function BillingBadges({ booking, charges }: { booking: BookingRow; charges: ChargeRow[] }) {
  if (booking.status === "cancelled" || booking.status === "no_show") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (booking.status !== "checked_out") {
    return <span className="text-xs text-muted-foreground">Settles at checkout</span>;
  }
  if (charges.length === 0) {
    // Checked out but nothing linked yet — either no hour-based facility
    // configured on this contract, or the charge insert failed at
    // checkout (logged server-side; worth a look if this shows up often).
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const parts = billingParts(booking, charges);
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex flex-wrap justify-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {parts.filter((p) => p.hours > 0).map((p) => (
          <span key={`${p.key}-hrs`}>{p.label} {formatHours(p.hours)}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 justify-center">
        {parts.map((p) =>
          p.quotaFree ? (
            <Badge key={p.key} className="text-[10px] bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border border-emerald-200">
              Quota free
            </Badge>
          ) : p.waived ? (
            <Badge key={p.key} className="text-[10px] bg-muted text-muted-foreground border border-border line-through">
              {p.label} waived {formatCurrency(p.amount)}
            </Badge>
          ) : (
            <Badge key={p.key} className="text-[10px] bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">
              {p.label} {formatCurrency(p.amount)}
            </Badge>
          )
        )}
      </div>
    </div>
  );
}

export function ContractBookingsSection({ contractId }: { contractId: string }) {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [charges, setCharges] = useState<ChargeRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from("bookings")
        .select("id, booking_number, booking_date, start_time, end_time, duration_hours, status, payment_status, check_in_at, check_out_at, space:spaces!bookings_space_id_fkey(name)")
        .eq("contract_id", contractId)
        .order("booking_date", { ascending: false });
      const rows = (data ?? []) as unknown as BookingRow[];

      let chargeRows: ChargeRow[] = [];
      const bookingIds = rows.map((r) => r.id);
      if (bookingIds.length > 0) {
        const { data: chargeData } = await supabase
          .from("usage_charges")
          .select("id, booking_id, status, quantity, total, unit_price, total_with_gst, booking_charge_kind")
          .in("booking_id", bookingIds)
          .not("contract_facility_id", "is", null);
        chargeRows = (chargeData ?? []) as unknown as ChargeRow[];
      }

      if (!cancelled) {
        setBookings(rows);
        setCharges(chargeRows);
        setLoading(false);
        if (rows.length > 0) {
          setOpenMonths(new Set([rows[0].booking_date.substring(0, 7)]));
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const chargesByBooking = useMemo(() => {
    const map = new Map<string, ChargeRow[]>();
    for (const c of charges) {
      if (!map.has(c.booking_id)) map.set(c.booking_id, []);
      map.get(c.booking_id)!.push(c);
    }
    return map;
  }, [charges]);

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
        const active = rows.filter((r) => r.status !== "cancelled" && r.status !== "no_show");
        const bookedHoursTotal = active.reduce((s, r) => s + Number(r.duration_hours), 0);
        const actualHoursTotal = active.reduce((s, r) => {
          if (!r.check_in_at || !r.check_out_at) return s;
          return s + actualHours(r.check_in_at, r.check_out_at);
        }, 0);
        const pendingTotal = rows.reduce((s, r) => {
          const cs = chargesByBooking.get(r.id) || [];
          return s + cs.filter((c) => c.status === "pending").reduce((s2, c) => s2 + Number(c.total_with_gst ?? 0), 0);
        }, 0);
        return { key, label, bookings: rows, bookedHoursTotal, actualHoursTotal, pendingTotal };
      });
  }, [bookings, chargesByBooking]);

  function toggleMonth(key: string) {
    setOpenMonths(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const bookedHoursAll = useMemo(
    () => bookings.filter(b => b.status !== "cancelled" && b.status !== "no_show").reduce((s, b) => s + Number(b.duration_hours), 0),
    [bookings]
  );
  const pendingTotalAll = useMemo(
    () => charges.filter((c) => c.status === "pending").reduce((s, c) => s + Number(c.total_with_gst ?? 0), 0),
    [charges]
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
              <span>{formatHours(bookedHoursAll)} booked</span>
              {pendingTotalAll > 0 && (
                <Badge className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">
                  {formatCurrency(pendingTotalAll)} pending
                </Badge>
              )}
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
                      <span className="font-medium text-foreground">
                        {formatHours(group.bookedHoursTotal)} booked
                        {group.actualHoursTotal > 0 && ` · ${formatHours(group.actualHoursTotal)} actual`}
                      </span>
                      {group.pendingTotal > 0 && (
                        <Badge className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">
                          {formatCurrency(group.pendingTotal)} pending
                        </Badge>
                      )}
                    </div>
                  </button>

                  {/* Expanded booking rows */}
                  {isOpen && (
                    <div className="divide-y divide-border">
                      {/* Table header */}
                      <div className="grid grid-cols-[1.3fr_1.1fr_1fr_0.8fr_1.6fr] gap-2 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        <span>Booking</span>
                        <span>Date / Time</span>
                        <span>Hrs</span>
                        <span className="text-center">Status</span>
                        <span className="text-center">Billing</span>
                      </div>

                      {group.bookings.map((b) => {
                        const actual = b.check_in_at && b.check_out_at ? actualHours(b.check_in_at, b.check_out_at) : null;
                        const overBooked = actual !== null && actual > Number(b.duration_hours);
                        return (
                          <div
                            key={b.id}
                            className="grid grid-cols-[1.3fr_1.1fr_1fr_0.8fr_1.6fr] gap-2 items-center px-4 py-2.5 text-sm hover:bg-muted/20 transition-colors"
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

                            {/* Booked vs actual hours */}
                            <div className="text-sm">
                              {b.status === "cancelled" || b.status === "no_show" ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <>
                                  <div className="text-xs text-muted-foreground">{formatHours(Number(b.duration_hours))} booked</div>
                                  {actual !== null && (
                                    <div className={`text-xs font-medium ${overBooked ? "text-amber-700" : "text-muted-foreground"}`}>
                                      {formatHours(actual)} actual
                                    </div>
                                  )}
                                </>
                              )}
                            </div>

                            {/* Booking status */}
                            <div className="flex justify-center">
                              <BookingStatusBadge status={b.status} />
                            </div>

                            {/* Billing — driven by linked usage_charges, not payment_status */}
                            <BillingBadges booking={b} charges={chargesByBooking.get(b.id) || []} />
                          </div>
                        );
                      })}

                      {/* Month subtotal */}
                      <div className="grid grid-cols-[1.3fr_1.1fr_1fr_0.8fr_1.6fr] gap-2 px-4 py-2 bg-muted/30 text-xs font-semibold text-muted-foreground">
                        <span className="col-span-2 text-right">Month total</span>
                        <span className="text-foreground">
                          {formatHours(group.bookedHoursTotal)}
                          {group.actualHoursTotal > 0 && <><br />{formatHours(group.actualHoursTotal)} actual</>}
                        </span>
                        <span />
                        <span className="text-center">
                          {group.pendingTotal > 0 ? formatCurrency(group.pendingTotal) + " pending" : ""}
                        </span>
                      </div>
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

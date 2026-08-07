"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, CalendarClock, Pencil, Power, Plus, Loader2, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { SpaceFormDialog } from "@/components/spaces/space-form-dialog";
import { SpaceChargesTab } from "@/components/spaces/space-charges-tab";
import { SpaceAccessTab } from "@/components/spaces/space-access-tab";
import { formatCurrency } from "@/lib/utils";
import { BOOKING_STATUS_COLORS, BOOKING_STATUS_LABELS, BOOKING_CUSTOMER_TYPE_LABELS } from "@/lib/constants";
import { toast } from "sonner";
import type { Space, Booking } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

const DAY_LABELS: Record<string, string> = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday",
  friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

export default function SpaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [space, setSpace] = useState<Space | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [toggling, setToggling] = useState(false);

  // Schedule state
  const [scheduleDate, setScheduleDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);

  const fetchSpace = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/spaces/${id}`);
    if (res.ok) {
      const json = await res.json();
      setSpace(json.data || null);
    }
    setLoading(false);
  }, [id]);

  const fetchSchedule = useCallback(async () => {
    setScheduleLoading(true);
    try {
      const res = await fetch(`/api/bookings?space_id=${id}&date_from=${scheduleDate}&date_to=${scheduleDate}&limit=50`);
      if (res.ok) {
        const json = await res.json();
        setBookings((json.data || []).filter((b: Booking) => b.status !== "cancelled"));
      }
    } catch { /* ignore */ }
    setScheduleLoading(false);
  }, [id, scheduleDate]);

  useEffect(() => { fetchSpace(); }, [fetchSpace]);
  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  const handleToggleActive = async () => {
    if (!space) return;
    setToggling(true);
    const res = await fetch(`/api/spaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !space.is_active }),
    });
    if (res.ok) {
      toast.success(space.is_active ? "Space deactivated" : "Space activated");
      fetchSpace();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update");
    }
    setToggling(false);
  };

  // Build timeline for the schedule view
  const getTimeSlots = () => {
    if (!space) return [];
    const dayOfWeek = new Date(scheduleDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const dayHours = space.operating_hours?.[dayOfWeek];
    if (!dayHours || !dayHours.is_open) return [];

    const [openH, openM] = dayHours.open.split(":").map(Number);
    const [closeH, closeM] = dayHours.close.split(":").map(Number);
    const startMin = openH * 60 + openM;
    const endMin = closeH * 60 + closeM;
    const slots: { time: string; label: string }[] = [];
    for (let m = startMin; m < endMin; m += 30) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const timeStr = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const ampm = h >= 12 ? "PM" : "AM";
      slots.push({ time: timeStr, label: `${h12}:${String(min).padStart(2, "0")} ${ampm}` });
    }
    return slots;
  };

  const getBookingForSlot = (slotTime: string) => {
    return bookings.find(b => {
      const start = b.start_time.slice(0, 5);
      const end = b.end_time.slice(0, 5);
      return slotTime >= start && slotTime < end;
    });
  };

  const isSlotStart = (slotTime: string) => {
    return bookings.some(b => b.start_time.slice(0, 5) === slotTime);
  };

  // Status-based slot colours — background + left accent border on the booking cell
  const SLOT_STATUS_STYLE: Record<string, string> = {
    confirmed:   "bg-blue-50 border-l-2 border-l-blue-400",
    checked_in:  "bg-green-50 border-l-2 border-l-green-500",
    checked_out: "bg-slate-100 border-l-2 border-l-slate-400",
    cancelled:   "bg-red-50 border-l-2 border-l-red-300",
    no_show:     "bg-orange-50 border-l-2 border-l-orange-400",
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  if (!space) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Space not found</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/spaces")}>Back to Spaces</Button>
      </div>
    );
  }

  const timeSlots = getTimeSlots();

  return (
    <div className="space-y-6">
      <PageBreadcrumb
        current={{ label: space.name }}
        fallbackParent={{ href: "/spaces", label: "Spaces" }}
      />
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/spaces")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{space.name}</h1>
              <Badge variant={space.is_active ? "default" : "secondary"}>
                {space.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {space.location?.name} &middot; {space.capacity} seats &middot; {formatCurrency(space.hourly_rate)}/hr
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1 h-4 w-4" />
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={handleToggleActive} disabled={toggling}>
            {toggling ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Power className="mr-1 h-4 w-4" />}
            {space.is_active ? "Deactivate" : "Activate"}
          </Button>
          <Link href={`/bookings/new?space_id=${space.id}`}>
            <Button size="sm">
              <Plus className="mr-1 h-4 w-4" />
              New Booking
            </Button>
          </Link>
        </div>
      </div>

      <Tabs defaultValue="schedule">
        <TabsList>
          <TabsTrigger value="schedule" className="gap-1.5">
            <CalendarClock className="h-4 w-4" />
            Schedule
          </TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="facilities">Facilities</TabsTrigger>
          <TabsTrigger value="charges">Charges</TabsTrigger>
          <TabsTrigger value="access" className="gap-1.5">
            <ShieldCheck className="h-4 w-4" />
            Access
          </TabsTrigger>
        </TabsList>

        {/* Schedule Tab */}
        <TabsContent value="schedule" className="space-y-4">
          <div className="flex items-center gap-3">
            <Input
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className="w-[180px]"
            />
            <span className="text-sm text-muted-foreground">
              {new Date(scheduleDate + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "short", year: "numeric" })}
            </span>
            {scheduleLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          {timeSlots.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                This room is closed on the selected day.
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <div className="grid grid-cols-[80px_1fr] divide-y">
                {timeSlots.map((slot) => {
                  const booking = getBookingForSlot(slot.time);
                  const isStart = isSlotStart(slot.time);
                  const slotStyle = booking
                    ? (SLOT_STATUS_STYLE[booking.status] ?? "bg-primary/10 border-l-2 border-l-primary")
                    : "";
                  return (
                    <div key={slot.time} className="contents">
                      {/* Time label — bolder + slightly tinted on booked slots */}
                      <div className={`px-3 py-2 text-xs border-r flex items-center ${booking ? "text-foreground/70 bg-muted/50" : "text-muted-foreground bg-muted/30"}`}>
                        {isStart ? <span className="font-medium">{slot.label}</span> : slot.label}
                      </div>
                      {/* Booking / free cell */}
                      <div className={`px-3 py-2 min-h-[40px] transition-colors ${slotStyle || "hover:bg-muted/20"}`}>
                        {booking && isStart && (
                          <div className="flex items-center gap-2 text-sm flex-wrap">
                            {/* Booking number — primary hyperlink */}
                            <Link
                              href={`/bookings/${booking.id}`}
                              className="font-mono font-semibold text-primary hover:underline text-xs shrink-0"
                            >
                              {booking.booking_number}
                            </Link>
                            <span className="text-muted-foreground text-xs shrink-0">
                              {booking.start_time.slice(0, 5)}–{booking.end_time.slice(0, 5)}
                            </span>
                            <span className="font-medium truncate">
                              {booking.lead
                                ? `${booking.lead.first_name} ${booking.lead.last_name}`
                                : booking.guest_name || "Guest"}
                            </span>
                            <Badge variant="secondary" className={`text-[10px] shrink-0 ${BOOKING_STATUS_COLORS[booking.status]}`}>
                              {BOOKING_STATUS_LABELS[booking.status]}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              {BOOKING_CUSTOMER_TYPE_LABELS[booking.customer_type]}
                            </Badge>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Details Tab */}
        <TabsContent value="details" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Room Info</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Location</span><span>{space.location?.name || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Capacity</span><span>{space.capacity} seats</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Hourly Rate</span><span>{formatCurrency(space.hourly_rate)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Max Advance Booking</span><span>{space.max_advance_booking_days} days</span></div>
                {space.pricing_model !== "daily" && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Min Booking</span><span>{space.min_booking_minutes} min</span></div>
                )}
                {space.description && (
                  <div className="pt-2 border-t">
                    <span className="text-muted-foreground">Description</span>
                    <p className="mt-1">{space.description}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Operating Hours</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {Object.entries(DAY_LABELS).map(([key, label]) => {
                  const day = space.operating_hours?.[key];
                  return (
                    <div key={key} className="flex justify-between">
                      <span className="text-muted-foreground">{label}</span>
                      <span>{day?.is_open ? `${day.open} – ${day.close}` : "Closed"}</span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          {space.cancellation_policy && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Cancellation Policy</CardTitle></CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap">{space.cancellation_policy}</CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Facilities Tab */}
        <TabsContent value="facilities" className="space-y-4">
          {!space.facilities || space.facilities.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No facilities configured for this room.
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Facility</th>
                  <th className="px-4 py-3 text-left font-medium">Pricing</th>
                  <th className="px-4 py-3 text-left font-medium">Available</th>
                </tr></thead>
                <tbody>
                  {space.facilities.map(f => (
                    <tr key={f.id} className="border-b">
                      <td className="px-4 py-3 font-medium">{f.name}</td>
                      <td className="px-4 py-3">
                        {f.is_complimentary ? (
                          <Badge variant="secondary" className="bg-green-100 text-green-800">Complimentary</Badge>
                        ) : (
                          <span>{formatCurrency(f.charge_per_use)}/use</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={f.is_available ? "default" : "secondary"}>
                          {f.is_available ? "Yes" : "No"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* Charges tab — per-space add-on catalogue (Tea, Coffee, Print, etc.) */}
        <TabsContent value="charges" className="space-y-4">
          <SpaceChargesTab spaceId={id} />
        </TabsContent>

        {/* Access tab — COSEC device info + door access logs */}
        <TabsContent value="access" className="space-y-4">
          <SpaceAccessTab deviceId={(space as unknown as Record<string, unknown>).cosec_device_id as string | null ?? null} spaceId={id} />
        </TabsContent>
      </Tabs>

      <SpaceFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        space={space}
        onSuccess={fetchSpace}
      />
    </div>
  );
}

"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, LogIn, LogOut, XCircle, Mail, Loader2,
  Clock, Users as UsersIcon, IndianRupee, Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { RecordPaymentDialog } from "@/components/bookings/record-payment-dialog";
import { formatDate, formatDateTime, formatCurrency } from "@/lib/utils";
import {
  BOOKING_STATUS_LABELS, BOOKING_STATUS_COLORS,
  BOOKING_CUSTOMER_TYPE_LABELS, BOOKING_CUSTOMER_TYPE_COLORS,
  BOOKING_PAYMENT_STATUS_LABELS, BOOKING_PAYMENT_STATUS_COLORS,
  PAYMENT_MODE_LABELS,
} from "@/lib/constants";
import { toast } from "sonner";
import type { Booking } from "@/types";

function formatTime12(timeStr: string): string {
  const [h, m] = timeStr.slice(0, 5).split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [booking, setBooking] = useState<Booking & { voucher_issuances?: { voucher?: { voucher_code: string }; is_active: boolean }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);

  const fetchBooking = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/bookings/${id}`);
    if (res.ok) {
      const json = await res.json();
      setBooking(json.data || null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchBooking(); }, [fetchBooking]);

  const handleStatusAction = async (action: string) => {
    const body: Record<string, string> = {};
    if (action === "check_in") body.status = "checked_in";
    if (action === "check_out") body.status = "checked_out";
    if (action === "cancel") body.status = "cancelled";
    if (action === "no_show") body.status = "no_show";

    setActionLoading(true);
    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      toast.success(
        action === "check_in" ? "Guest checked in" :
        action === "check_out" ? "Guest checked out" :
        action === "cancel" ? "Booking cancelled" :
        "Marked as no-show"
      );
      fetchBooking();

      // On checkout, send cleaning alert
      if (action === "check_out") {
        fetch(`/api/bookings/${id}/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "cleaning" }),
        }).catch(() => {});
      }
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Action failed");
    }
    setActionLoading(false);
  };

  const handleResendEmail = async () => {
    const res = await fetch(`/api/bookings/${id}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "confirmation" }),
    });
    if (res.ok) {
      toast.success("Confirmation email sent");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to send email");
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Booking not found</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/bookings")}>Back to Bookings</Button>
      </div>
    );
  }

  const customerName = booking.lead
    ? `${booking.lead.first_name} ${booking.lead.last_name}`
    : booking.guest_name || "Guest";
  const customerEmail = booking.lead?.email || booking.guest_email;
  const customerPhone = booking.lead?.phone || booking.guest_phone;
  const activeVoucher = booking.voucher_issuances?.find(v => v.is_active);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/bookings")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">{booking.booking_number}</h1>
              <Badge variant="secondary" className={BOOKING_STATUS_COLORS[booking.status]}>
                {BOOKING_STATUS_LABELS[booking.status]}
              </Badge>
              <Badge variant="outline" className={BOOKING_CUSTOMER_TYPE_COLORS[booking.customer_type]}>
                {BOOKING_CUSTOMER_TYPE_LABELS[booking.customer_type]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {booking.space?.name} &middot; {formatDate(booking.booking_date)}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {booking.status === "confirmed" && (
            <>
              <Button size="sm" onClick={() => handleStatusAction("check_in")} disabled={actionLoading}>
                <LogIn className="mr-1 h-4 w-4" />Check In
              </Button>
              <Button variant="outline" size="sm" onClick={handleResendEmail}>
                <Mail className="mr-1 h-4 w-4" />Resend Email
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleStatusAction("no_show")} disabled={actionLoading}>
                No Show
              </Button>
              <Button variant="destructive" size="sm" onClick={() => handleStatusAction("cancel")} disabled={actionLoading}>
                <XCircle className="mr-1 h-4 w-4" />Cancel
              </Button>
            </>
          )}
          {booking.status === "checked_in" && (
            <Button size="sm" onClick={() => handleStatusAction("check_out")} disabled={actionLoading}>
              <LogOut className="mr-1 h-4 w-4" />Check Out
            </Button>
          )}
          {booking.payment_status === "pending" && booking.customer_type === "walk_in" && (
            <Button variant="outline" size="sm" onClick={() => setPaymentDialogOpen(true)}>
              <IndianRupee className="mr-1 h-4 w-4" />Record Payment
            </Button>
          )}
          {actionLoading && <Loader2 className="h-4 w-4 animate-spin self-center" />}
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Room */}
        <Card>
          <CardHeader><CardTitle className="text-sm">Room</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Space</span>
              <Link href={`/spaces/${booking.space_id}`} className="text-primary hover:underline">
                {booking.space?.name || "—"}
              </Link>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Location</span>
              <span>{booking.location?.name || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Capacity</span>
              <span>{booking.space?.capacity || "—"} seats</span>
            </div>
          </CardContent>
        </Card>

        {/* Schedule */}
        <Card>
          <CardHeader><CardTitle className="text-sm">Schedule</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Date</span>
              <span>{formatDate(booking.booking_date)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Time</span>
              <span>{formatTime12(booking.start_time)} – {formatTime12(booking.end_time)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Duration</span>
              <span>{booking.duration_hours} hour(s)</span>
            </div>
          </CardContent>
        </Card>

        {/* Customer */}
        <Card>
          <CardHeader><CardTitle className="text-sm">Customer</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Name</span>
              {booking.lead ? (
                <Link href={`/leads/${booking.lead.id}`} className="text-primary hover:underline">{customerName}</Link>
              ) : (
                <span>{customerName}</span>
              )}
            </div>
            {customerEmail && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Email</span>
                <span>{customerEmail}</span>
              </div>
            )}
            {customerPhone && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone</span>
                <span>{customerPhone}</span>
              </div>
            )}
            {(booking.guest_company || booking.lead?.company) && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Company</span>
                <span>{booking.guest_company || booking.lead?.company}</span>
              </div>
            )}
            {booking.contract_id && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Contract</span>
                <Link href={`/contracts/${booking.contract_id}`} className="text-primary hover:underline">
                  {booking.contract?.contract_number || booking.contract_id.slice(0, 8)}
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Financials */}
        <Card>
          <CardHeader><CardTitle className="text-sm">Financials</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hourly Rate</span>
              <span>{formatCurrency(booking.hourly_rate)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span className="text-muted-foreground">Total Amount</span>
              <span>{formatCurrency(booking.total_amount)}</span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Payment Status</span>
              <Badge variant="secondary" className={BOOKING_PAYMENT_STATUS_COLORS[booking.payment_status]}>
                {BOOKING_PAYMENT_STATUS_LABELS[booking.payment_status]}
              </Badge>
            </div>
            {booking.payment_mode && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payment Mode</span>
                <span>{PAYMENT_MODE_LABELS[booking.payment_mode] || booking.payment_mode}</span>
              </div>
            )}
            {booking.payment_reference && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reference</span>
                <span className="font-mono text-xs">{booking.payment_reference}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Session */}
        {(booking.check_in_at || booking.check_out_at) && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Session</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {booking.check_in_at && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Checked In</span>
                  <span>{formatDateTime(booking.check_in_at)}</span>
                </div>
              )}
              {booking.check_out_at && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Checked Out</span>
                  <span>{formatDateTime(booking.check_out_at)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Voucher */}
        {activeVoucher && (
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Wifi className="h-4 w-4" />WiFi Voucher</CardTitle></CardHeader>
            <CardContent className="text-sm">
              <p className="font-mono text-lg font-bold tracking-wider text-center py-2">
                {activeVoucher.voucher?.voucher_code || "—"}
              </p>
              <p className="text-xs text-muted-foreground text-center">Valid for 24 hours</p>
            </CardContent>
          </Card>
        )}

        {/* Facilities */}
        {booking.facilities && booking.facilities.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Facilities</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-1.5 text-sm">
                {booking.facilities.map((f) => (
                  <div key={f.id} className="flex justify-between">
                    <span>{f.facility_name}</span>
                    <span className="text-muted-foreground">
                      {f.is_complimentary ? "Free" : formatCurrency(f.charge)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Notes */}
      {booking.notes && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Notes</CardTitle></CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{booking.notes}</CardContent>
        </Card>
      )}

      <RecordPaymentDialog
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
        bookingId={booking.id}
        amount={booking.total_amount}
        onSuccess={fetchBooking}
      />
    </div>
  );
}

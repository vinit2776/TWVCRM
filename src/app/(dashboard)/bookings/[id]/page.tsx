"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, LogIn, LogOut, XCircle, Mail, Loader2,
  Clock, Users as UsersIcon, IndianRupee, Wifi,
  Phone, AlertTriangle, ShieldCheck, Star,
  Banknote, CheckCircle, Calendar, Timer, Copy,
  Link2, Download, MessageCircle, Repeat, RotateCcw,
  StickyNote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { CollectPaymentDialog } from "@/components/bookings/collect-payment-dialog";
import { NoShowRefundDialog } from "@/components/bookings/no-show-refund-dialog";
import { CheckoutFeedbackDialog } from "@/components/bookings/checkout-feedback-dialog";
import { RescheduleDialog } from "@/components/bookings/reschedule-dialog";
import { ExtendBookingDialog } from "@/components/bookings/extend-booking-dialog";
import { CustomerHistoryCard } from "@/components/bookings/customer-history-card";
import { BookingNotesTemplates } from "@/components/bookings/booking-notes-templates";
import { formatDate, formatDateTime, formatCurrency } from "@/lib/utils";
import {
  BOOKING_STATUS_LABELS, BOOKING_STATUS_COLORS,
  BOOKING_CUSTOMER_TYPE_LABELS, BOOKING_CUSTOMER_TYPE_COLORS,
  BOOKING_PAYMENT_STATUS_LABELS, BOOKING_PAYMENT_STATUS_COLORS,
  PAYMENT_MODE_LABELS,
  BOOKING_PAYMENT_MODE_LABELS,
  BOOKING_PAYMENT_RECORD_STATUS_LABELS,
  BOOKING_PAYMENT_RECORD_STATUS_COLORS,
  FEEDBACK_DIMENSIONS,
} from "@/lib/constants";
import type { BookingFeedback, BookingPayment } from "@/types";
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
  const searchParams = useSearchParams();
  const [booking, setBooking] = useState<Booking & { voucher_issuances?: { voucher?: { voucher_code: string }; is_active: boolean }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [rescheduleDialogOpen, setRescheduleDialogOpen] = useState(false);
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);

  // Payment records + gateway config
  const [existingPayments, setExistingPayments] = useState<BookingPayment[]>([]);
  const [razorpayEnabled, setRazorpayEnabled] = useState(false);
  const [razorpayKeyId, setRazorpayKeyId] = useState("");
  const [upiId, setUpiId] = useState("");
  const [upiQrCodePath, setUpiQrCodePath] = useState("");

  const fetchBooking = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/bookings/${id}`);
    if (res.ok) {
      const json = await res.json();
      setBooking(json.data || null);
    }

    // Fetch existing payment records
    const paymentsRes = await fetch(`/api/booking-payments?booking_id=${id}`);
    if (paymentsRes.ok) {
      const pJson = await paymentsRes.json();
      setExistingPayments(pJson.data || []);
    }

    // Fetch public gateway settings
    const settingsRes = await fetch("/api/settings/public");
    if (settingsRes.ok) {
      const sJson = await settingsRes.json();
      const settings = sJson.data || {};
      setRazorpayEnabled(settings.razorpay_enabled === "true");
      setRazorpayKeyId(settings.razorpay_key_id || "");
      setUpiId(settings.upi_id || "");
      setUpiQrCodePath(settings.upi_qr_code_path || "");
    }

    setLoading(false);
  }, [id]);

  useEffect(() => { fetchBooking(); }, [fetchBooking]);

  // Auto-open collect payment dialog if redirected from booking creation
  useEffect(() => {
    if (searchParams.get("collect_payment") === "true" && !loading && booking) {
      setPaymentDialogOpen(true);
    }
  }, [searchParams, loading, booking]);

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

      // On check-in, send floor manager alert
      if (action === "check_in") {
        fetch(`/api/bookings/${id}/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "check_in_alert" }),
        }).catch(() => {});
      }

      // On checkout, send cleaning alert and open feedback dialog
      if (action === "check_out") {
        fetch(`/api/bookings/${id}/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "cleaning" }),
        }).catch(() => {});
        setFeedbackDialogOpen(true);
      }
    } else if (res.status === 402) {
      // Payment required — open collect-payment dialog
      const err = await res.json().catch(() => null);
      if (err?.payment_required) {
        toast.info("Payment required before check-in. Please collect payment first.");
        setPaymentDialogOpen(true);
      } else {
        toast.error(err?.error || "Payment required");
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

  const handleCopyFeedbackLink = () => {
    if (!booking?.feedback_token) { toast.error("No feedback token"); return; }
    const url = `${window.location.origin}/feedback/${booking.feedback_token}`;
    navigator.clipboard.writeText(url).then(() => toast.success("Feedback link copied")).catch(() => toast.error("Failed to copy"));
  };

  const handleSendFeedbackLink = async () => {
    const res = await fetch(`/api/bookings/${id}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "feedback_link" }),
    });
    if (res.ok) {
      toast.success("Feedback link sent to customer");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to send");
    }
  };

  const handleSendPaymentLink = async () => {
    const res = await fetch(`/api/bookings/${id}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "payment_link" }),
    });
    if (res.ok) {
      toast.success("Payment link sent to customer");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to send");
    }
  };

  const handleCopyPaymentLink = () => {
    if (!booking?.payment_token) { toast.error("No payment token"); return; }
    const url = `${window.location.origin}/pay/${booking.payment_token}`;
    navigator.clipboard.writeText(url).then(() => toast.success("Payment link copied")).catch(() => toast.error("Failed to copy"));
  };

  const handleDownloadReceipt = async () => {
    try {
      const res = await fetch(`/api/bookings/${id}/receipt`);
      if (!res.ok) { toast.error("Failed to generate receipt"); return; }
      const json = await res.json();
      // Open receipt data in new tab for print/save
      const receiptData = json.data;
      const win = window.open("", "_blank");
      if (!win) { toast.error("Popup blocked"); return; }
      win.document.write(`
        <html><head><title>Receipt - ${receiptData.booking.booking_number}</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; }
          h1 { color: #015E65; font-size: 24px; } h2 { font-size: 16px; margin-top: 24px; color: #333; }
          table { width: 100%; border-collapse: collapse; margin: 12px 0; }
          td { padding: 6px 0; } .label { color: #666; } .amount { text-align: right; font-weight: bold; }
          .total { border-top: 2px solid #015E65; font-size: 18px; padding-top: 12px; }
          .footer { margin-top: 40px; text-align: center; color: #999; font-size: 12px; }
          @media print { body { margin: 0; } }
        </style></head><body>
        <h1>The WorkVilla</h1>
        <p style="color:#00AE6C;font-size:14px;">Booking Receipt</p>
        <hr/>
        <h2>Booking Details</h2>
        <table>
          <tr><td class="label">Booking #</td><td>${receiptData.booking.booking_number}</td></tr>
          <tr><td class="label">Space</td><td>${receiptData.booking.space_name}</td></tr>
          <tr><td class="label">Date</td><td>${receiptData.booking.booking_date}</td></tr>
          <tr><td class="label">Time</td><td>${receiptData.booking.start_time} - ${receiptData.booking.end_time}</td></tr>
          <tr><td class="label">Duration</td><td>${receiptData.booking.duration_hours} hour(s)</td></tr>
          <tr><td class="label">Customer</td><td>${receiptData.booking.customer_name}</td></tr>
        </table>
        <h2>Payment Summary</h2>
        <table>
          <tr><td class="label">Total Amount</td><td class="amount">₹${receiptData.booking.total_amount?.toLocaleString("en-IN")}</td></tr>
          ${receiptData.payments.map((p: { amount: number; payment_mode: string; status: string }) =>
            `<tr><td class="label">${p.payment_mode} (${p.status})</td><td class="amount">₹${p.amount.toLocaleString("en-IN")}</td></tr>`
          ).join("")}
        </table>
        ${receiptData.voucher ? `<p><strong>WiFi Voucher:</strong> ${receiptData.voucher.voucher_code}</p>` : ""}
        <div class="footer">
          <p>${receiptData.company.name}</p>
          <p>${receiptData.company.address}</p>
        </div>
        <script>window.print();</script>
        </body></html>
      `);
      win.document.close();
    } catch {
      toast.error("Failed to generate receipt");
    }
  };

  const handleNotesUpdate = async (newNotes: string) => {
    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: newNotes }),
    });
    if (res.ok) {
      toast.success("Notes updated");
      fetchBooking();
    } else {
      toast.error("Failed to update notes");
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
              {booking.series_id && (
                <Badge variant="outline" className="bg-indigo-50 text-indigo-700 text-[10px]">
                  <Repeat className="h-3 w-3 mr-1" />Recurring
                </Badge>
              )}
              {booking.reschedule_count && booking.reschedule_count > 0 && (
                <Badge variant="outline" className="bg-amber-50 text-amber-700 text-[10px]">
                  Rescheduled x{booking.reschedule_count}
                </Badge>
              )}
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
              <Button variant="outline" size="sm" onClick={() => setRescheduleDialogOpen(true)}>
                <Calendar className="mr-1 h-4 w-4" />Reschedule
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
            <>
              <Button size="sm" onClick={() => handleStatusAction("check_out")} disabled={actionLoading}>
                <LogOut className="mr-1 h-4 w-4" />Check Out
              </Button>
              <Button variant="outline" size="sm" onClick={() => setExtendDialogOpen(true)}>
                <Timer className="mr-1 h-4 w-4" />Extend
              </Button>
            </>
          )}
          {booking.customer_type === "walk_in" && booking.payment_status !== "paid" && (
            <Button variant="outline" size="sm" onClick={() => setPaymentDialogOpen(true)}>
              <IndianRupee className="mr-1 h-4 w-4" />Collect Payment
            </Button>
          )}
          {booking.status === "no_show" && !booking.refund_status && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefundDialogOpen(true)}
              className="border-orange-300 text-orange-700 hover:bg-orange-50"
            >
              <ShieldCheck className="mr-1 h-4 w-4" />Request Refund Exception
            </Button>
          )}
          {booking.status === "checked_out" && !booking.feedback && (
            <Button variant="outline" size="sm" onClick={() => setFeedbackDialogOpen(true)}>
              <Star className="mr-1 h-4 w-4 text-amber-500" />Give Feedback
            </Button>
          )}
          {actionLoading && <Loader2 className="h-4 w-4 animate-spin self-center" />}
        </div>
      </div>

      {/* Quick Action Links */}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleDownloadReceipt}>
          <Download className="mr-1 h-3.5 w-3.5" />Download Receipt
        </Button>
        {booking.status === "checked_out" && booking.feedback_token && (
          <>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleCopyFeedbackLink}>
              <Copy className="mr-1 h-3.5 w-3.5" />Copy Feedback Link
            </Button>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleSendFeedbackLink}>
              <MessageCircle className="mr-1 h-3.5 w-3.5" />Send Feedback Link
            </Button>
          </>
        )}
        {booking.payment_status !== "paid" && booking.payment_token && (
          <>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleCopyPaymentLink}>
              <Link2 className="mr-1 h-3.5 w-3.5" />Copy Payment Link
            </Button>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleSendPaymentLink}>
              <Mail className="mr-1 h-3.5 w-3.5" />Send Payment Link
            </Button>
          </>
        )}
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
            {booking.original_booking_date && (
              <>
                <Separator />
                <p className="text-xs text-muted-foreground font-medium">Original Schedule</p>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Date</span>
                  <span>{formatDate(booking.original_booking_date)}</span>
                </div>
                {booking.original_start_time && booking.original_end_time && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Time</span>
                    <span>{formatTime12(booking.original_start_time)} – {formatTime12(booking.original_end_time)}</span>
                  </div>
                )}
              </>
            )}
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
            {booking.booker_phone && booking.booker_phone !== customerPhone && (
              <div className="flex justify-between">
                <span className="text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" />Booker Phone</span>
                <span>{booking.booker_phone}</span>
              </div>
            )}
            {booking.booker_phone && !customerPhone && (
              <div className="flex justify-between">
                <span className="text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" />Phone</span>
                <span>{booking.booker_phone}</span>
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

            {/* Payment summary from booking_payments */}
            {(() => {
              const verifiedTotal = existingPayments
                .filter((p) => p.status === "verified")
                .reduce((sum, p) => sum + Number(p.amount), 0);
              const pendingTotal = existingPayments
                .filter((p) => p.status === "pending")
                .reduce((sum, p) => sum + Number(p.amount), 0);
              const balanceDue = Math.max(0, Number(booking.total_amount) - verifiedTotal);

              return (
                <>
                  {existingPayments.length > 0 && (
                    <>
                      <Separator />
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Amount Paid</span>
                        <span className="font-medium text-green-700">{formatCurrency(verifiedTotal)}</span>
                      </div>
                      {pendingTotal > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Pending Verification</span>
                          <span className="text-amber-600">{formatCurrency(pendingTotal)}</span>
                        </div>
                      )}
                      {balanceDue > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Balance Due</span>
                          <span className="font-medium text-red-600">{formatCurrency(balanceDue)}</span>
                        </div>
                      )}
                    </>
                  )}
                </>
              );
            })()}

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

            {/* Individual payment records */}
            {existingPayments.length > 0 && (
              <>
                <Separator />
                <p className="text-xs text-muted-foreground font-medium">Payment Records</p>
                <div className="space-y-1.5">
                  {existingPayments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{formatCurrency(p.amount)}</span>
                        <span className="text-muted-foreground">
                          {BOOKING_PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode}
                        </span>
                      </div>
                      <Badge variant="secondary" className={`text-[10px] ${BOOKING_PAYMENT_RECORD_STATUS_COLORS[p.status]}`}>
                        {BOOKING_PAYMENT_RECORD_STATUS_LABELS[p.status]}
                      </Badge>
                    </div>
                  ))}
                </div>
              </>
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
              {booking.no_show_detected_at && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">No-Show Detected</span>
                  <span>{formatDateTime(booking.no_show_detected_at)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Refund Info (No-Show Exception) */}
        {booking.status === "no_show" && booking.refund_status && (
          <Card className="border-orange-200">
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-orange-600" />
                Refund Exception
                <Badge variant="secondary" className="bg-orange-100 text-orange-800 text-xs">
                  {booking.refund_status === "approved" ? "Approved" : booking.refund_status === "processed" ? "Processed" : "Requested"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Refund Amount</span>
                <span className="font-bold text-orange-700">{formatCurrency(booking.refund_amount || 0)}</span>
              </div>
              {booking.refund_reason && (
                <div>
                  <span className="text-muted-foreground text-xs">Reason</span>
                  <p className="text-sm mt-0.5">{booking.refund_reason}</p>
                </div>
              )}
              {booking.refund_approved_at && (
                <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t">
                  <span>Approved at</span>
                  <span>{formatDateTime(booking.refund_approved_at)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* No-Show without refund */}
        {booking.status === "no_show" && !booking.refund_status && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-amber-800">No-Show — No Refund</p>
                  <p className="text-amber-700 text-xs mt-1">
                    Standard policy applied. If an exception is needed, use the &ldquo;Request Refund Exception&rdquo; button above.
                  </p>
                </div>
              </div>
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

        {/* Customer Feedback */}
        {booking.feedback && !Array.isArray(booking.feedback) && (
          <FeedbackCard feedback={booking.feedback} />
        )}
      </div>

      {/* Customer History */}
      {(booking.booker_phone || booking.lead?.phone || booking.guest_phone) && (
        <CustomerHistoryCard
          phone={booking.booker_phone || booking.lead?.phone || booking.guest_phone || ""}
          leadId={booking.lead?.id}
        />
      )}

      {/* Notes with Templates */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <StickyNote className="h-4 w-4" />
            Notes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {booking.notes && (
            <p className="text-sm whitespace-pre-wrap bg-muted/30 rounded p-3">{booking.notes}</p>
          )}
          <BookingNotesTemplates
            onInsert={(text) => {
              const updated = booking.notes ? `${booking.notes}\n${text}` : text;
              handleNotesUpdate(updated);
            }}
          />
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CollectPaymentDialog
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
        bookingId={booking.id}
        totalAmount={Number(booking.total_amount)}
        onSuccess={fetchBooking}
        razorpayEnabled={razorpayEnabled}
        razorpayKeyId={razorpayKeyId}
        upiId={upiId}
        upiQrCodePath={upiQrCodePath}
      />

      <NoShowRefundDialog
        open={refundDialogOpen}
        onOpenChange={setRefundDialogOpen}
        bookingId={booking.id}
        bookingNumber={booking.booking_number || ""}
        totalAmount={booking.total_amount}
        customerName={customerName}
        onSuccess={fetchBooking}
      />

      <CheckoutFeedbackDialog
        open={feedbackDialogOpen}
        onOpenChange={setFeedbackDialogOpen}
        bookingId={booking.id}
        bookingNumber={booking.booking_number || ""}
        customerName={customerName}
        onSuccess={fetchBooking}
      />

      <RescheduleDialog
        open={rescheduleDialogOpen}
        onOpenChange={setRescheduleDialogOpen}
        bookingId={booking.id}
        currentDate={booking.booking_date}
        currentStart={booking.start_time}
        currentEnd={booking.end_time}
        onRescheduled={fetchBooking}
      />

      <ExtendBookingDialog
        open={extendDialogOpen}
        onOpenChange={setExtendDialogOpen}
        bookingId={booking.id}
        currentEnd={booking.end_time}
        hourlyRate={booking.hourly_rate}
        onExtended={fetchBooking}
      />
    </div>
  );
}

function FeedbackCard({ feedback }: { feedback: BookingFeedback }) {
  const overallColor =
    (feedback.overall_rating ?? 0) >= 4
      ? "bg-green-100 text-green-800"
      : (feedback.overall_rating ?? 0) >= 3
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";

  return (
    <Card className="border-amber-200">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500" />
          Customer Feedback
          {feedback.overall_rating != null && (
            <Badge variant="secondary" className={overallColor}>
              {feedback.overall_rating.toFixed(1)} / 5
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm">
        {FEEDBACK_DIMENSIONS.map((dim) => {
          const val = feedback[dim.key as keyof BookingFeedback] as number | null;
          if (val == null) return null;
          return (
            <div key={dim.key} className="flex items-center justify-between">
              <span className="text-muted-foreground">{dim.label}</span>
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star
                    key={s}
                    className={`h-3.5 w-3.5 ${
                      s <= val
                        ? "fill-amber-400 text-amber-400"
                        : "fill-none text-gray-300"
                    }`}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {feedback.notes && (
          <>
            <Separator />
            <div>
              <span className="text-muted-foreground text-xs">Notes</span>
              <p className="mt-0.5 whitespace-pre-wrap">{feedback.notes}</p>
            </div>
          </>
        )}
        {feedback.rater && (
          <div className="text-xs text-muted-foreground pt-1 border-t">
            Rated by {feedback.rater.full_name} on {formatDate(feedback.created_at)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

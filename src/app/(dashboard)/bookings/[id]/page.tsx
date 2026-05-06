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
  StickyNote, Receipt, Pencil, Check, X, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/shared/loading-skeleton";
// Dialogs are dynamic-imported. They only render when their open prop flips
// to true, so the JS doesn't need to ship in the initial bundle. SSR off
// because each dialog is fully client-state-driven (forms, file uploads).
import dynamic from "next/dynamic";
const CollectPaymentDialog   = dynamic(() => import("@/components/bookings/collect-payment-dialog").then(m => m.CollectPaymentDialog),      { ssr: false });
const NoShowRefundDialog     = dynamic(() => import("@/components/bookings/no-show-refund-dialog").then(m => m.NoShowRefundDialog),         { ssr: false });
const CheckoutFeedbackDialog = dynamic(() => import("@/components/bookings/checkout-feedback-dialog").then(m => m.CheckoutFeedbackDialog), { ssr: false });
const RescheduleDialog       = dynamic(() => import("@/components/bookings/reschedule-dialog").then(m => m.RescheduleDialog),               { ssr: false });
const ExtendBookingDialog    = dynamic(() => import("@/components/bookings/extend-booking-dialog").then(m => m.ExtendBookingDialog),       { ssr: false });
const AddUsageChargeDialog   = dynamic(() => import("@/components/billing/add-usage-charge-dialog").then(m => m.AddUsageChargeDialog),     { ssr: false });
const WaiverRequestDialog    = dynamic(() => import("@/components/bookings/waiver-request-dialog").then(m => m.WaiverRequestDialog),       { ssr: false });
import { BookingAddonsSection } from "@/components/bookings/booking-addons-section";
import { BookingPaymentSummary } from "@/components/bookings/booking-payment-summary";
import { CustomerHistoryCard } from "@/components/bookings/customer-history-card";
import { BookingNotesTemplates } from "@/components/bookings/booking-notes-templates";
import { BookingLifecycleTimeline } from "@/components/bookings/booking-lifecycle-timeline";
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

function formatDuration(hours: number): string {
  if (hours <= 0) return "—";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h 00m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
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
  const [logChargeOpen, setLogChargeOpen] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [convertingFromBill, setConvertingFromBill] = useState(false);
  const [pendingOvertimeCharge, setPendingOvertimeCharge] = useState<{ minutes: number; hours: number; hourly_rate: number; charge: number } | null>(null);
  // For day-pass overtime, we open the addons dialog with the suggested
  // "Extended time" line pre-filled. The number is just a tick to retrigger.
  const [addonOpenSignal, setAddonOpenSignal] = useState<number>(0);
  // Addons section is lazy — only mounted after the user clicks "Add charge"
  // (or when a checkout overtime prompt needs it). Prevents an extra API call
  // on every booking page load.
  const [showAddonsSection, setShowAddonsSection] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [addonPrefill, setAddonPrefill] = useState<any>(null);
  const [outstandingCharges, setOutstandingCharges] = useState<Array<{
    id: string;
    description: string;
    total: number;
    quantity?: number;
    unit_price?: number;
    charge_date: string;
    notes?: string;
    proof_path?: string;
    booking?: { booking_number: string; booking_date: string } | null;
  }>>([]);
  const [expandedChargeId, setExpandedChargeId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);

  // GST inline-edit state
  const [editingGst, setEditingGst] = useState(false);
  const [draftGst, setDraftGst] = useState("");
  const [gstSaving, setGstSaving] = useState(false);
  const [gstError, setGstError] = useState<string | null>(null);

  // Pricing inline-edit state
  const [editingPricing, setEditingPricing] = useState(false);
  const [draftRate, setDraftRate] = useState("");
  const [draftTotal, setDraftTotal] = useState("");
  const [pricingSaving, setPricingSaving] = useState(false);

  // Payment records + gateway config
  const [existingPayments, setExistingPayments] = useState<BookingPayment[]>([]);
  const [upiId, setUpiId] = useState("");
  const [upiQrCodePath, setUpiQrCodePath] = useState("");

  const fetchBooking = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/bookings/${id}`);
    let leadId: string | null = null;
    if (res.ok) {
      const json = await res.json();
      setBooking(json.data || null);
      leadId = json.data?.lead_id ?? null;
    }

    // Fetch existing payment records
    const paymentsRes = await fetch(`/api/booking-payments?booking_id=${id}`);
    if (paymentsRes.ok) {
      const pJson = await paymentsRes.json();
      setExistingPayments(pJson.data || []);
    }

    // Fetch outstanding booking charges for this customer (from other bookings)
    if (leadId) {
      const ocRes = await fetch(
        `/api/usage-charges?lead_id=${leadId}&status=pending&limit=50`
      );
      if (ocRes.ok) {
        const ocJson = await ocRes.json();
        // Only show charges linked to a booking (not contract), excluding the current booking
        const bookingCharges = (ocJson.data || []).filter(
          (c: { booking_id?: string | null }) =>
            c.booking_id && c.booking_id !== id
        );
        setOutstandingCharges(bookingCharges);
      }
    }

    // Fetch public gateway settings
    const settingsRes = await fetch("/api/settings/public");
    if (settingsRes.ok) {
      const sJson = await settingsRes.json();
      const settings = sJson.data || {};
      setUpiId(settings.upi_id || "");
      setUpiQrCodePath(settings.upi_qr_code_path || "");
    }

    setLoading(false);
  }, [id]);

  useEffect(() => { fetchBooking(); }, [fetchBooking]);
  useEffect(() => { fetch("/api/me").then(r => r.json()).then(j => setUserRole(j.role || null)).catch(() => {}); }, []);

  const handlePricingSave = async () => {
    const newRate = parseFloat(draftRate);
    const newTotal = parseFloat(draftTotal);
    if (isNaN(newRate) || newRate < 0) { toast.error("Hourly rate must be 0 or greater"); return; }
    if (isNaN(newTotal) || newTotal < 0) { toast.error("Total amount must be 0 or greater"); return; }
    setPricingSaving(true);
    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_pricing", hourly_rate: newRate, total_amount: newTotal }),
    });
    if (res.ok) {
      const json = await res.json();
      setBooking(json.data);
      setEditingPricing(false);
      toast.success("Pricing updated");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update pricing");
    }
    setPricingSaving(false);
  };

  const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

  const handleGstSave = async () => {
    const val = draftGst.trim().toUpperCase();
    if (val && !GST_REGEX.test(val)) {
      setGstError("Format: 33AAAAA0000A1Z5 (15 characters)");
      return;
    }
    if (!booking?.lead_id) { toast.error("No lead associated with this booking"); return; }
    setGstSaving(true);
    const res = await fetch(`/api/leads/${booking.lead_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gst_number: val || "" }),
    });
    if (res.ok) {
      setBooking((prev) => prev ? { ...prev, lead: prev.lead ? { ...prev.lead, gst_number: val || undefined } : prev.lead } : prev);
      setEditingGst(false);
      setGstError(null);
      toast.success("GST number updated");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update GST number");
    }
    setGstSaving(false);
  };

  // Poll for payment updates when a Razorpay payment link is active and payment is pending
  useEffect(() => {
    if (!booking) return;
    if (booking.payment_status === "paid") return;
    if (!booking.razorpay_payment_link_id) return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/bookings/${id}`);
      if (!res.ok) return;
      const json = await res.json();
      const updated = json.data;
      if (!updated) return;

      // Payment confirmed — use fresh data directly, no stale closure comparison needed
      if (updated.payment_status === "paid") {
        setBooking(updated);
        // Also refresh payment records
        const pRes = await fetch(`/api/booking-payments?booking_id=${id}`);
        if (pRes.ok) {
          const pJson = await pRes.json();
          setExistingPayments(pJson.data || []);
        }
        toast.success("Payment collected successfully via Razorpay!");
        // No clearInterval here — effect cleanup fires when payment_status dep changes to "paid"
      }
    }, 10000); // Poll every 10 seconds

    return () => clearInterval(interval);
  }, [booking?.payment_status, booking?.razorpay_payment_link_id, id]); // `booking` removed — prevented interval from restarting on every poll

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
      const resJson = await res.json().catch(() => ({ data: null }));
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

      // On checkout, check for overtime charges and open feedback dialog
      if (action === "check_out") {
        fetch(`/api/bookings/${id}/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "cleaning" }),
        }).catch(() => {});

        // Show overtime alert if applicable
        if (resJson.overtime) {
          const ot = resJson.overtime;
          if (ot.is_day_pass && ot.suggested_addon) {
            // Day-pass: open the addons dialog with extended-time pre-filled.
            // Day rate is NEVER multiplied by extra hours; this is a separate
            // catalog item (default ₹100/hr).
            setAddonPrefill({
              addon_catalog_id: ot.addon_catalog_id,
              addon_type: ot.suggested_addon.addon_type,
              description: ot.suggested_addon.description,
              quantity: ot.suggested_addon.quantity,
              unit_price: ot.suggested_addon.unit_price,
              unit_label: ot.suggested_addon.unit_label,
              gst_rate: ot.suggested_addon.gst_rate,
            });
            setShowAddonsSection(true); // ensure section is mounted before signal fires
            setAddonOpenSignal(Date.now());
            toast.warning(
              `Customer stayed ${ot.minutes} min past closing`,
              {
                description: `Suggest adding "Extended time": ${ot.hours}h × ₹${Number(ot.unit_price).toLocaleString("en-IN")}/hr = ₹${Number(ot.charge).toLocaleString("en-IN")} (+ GST). Adjust quantity or skip if waiving.`,
                duration: 15000,
              }
            );
          } else {
            setPendingOvertimeCharge(ot);
            toast.warning(
              `Overtime: ${ot.minutes} min past booking end`,
              {
                description: `Differential charge: ₹${ot.charge.toLocaleString("en-IN")} (${ot.hours}h × ₹${Number(ot.hourly_rate).toLocaleString("en-IN")}/hr). Collect payment or request manager waiver.`,
                duration: 15000,
              }
            );
            // Open payment dialog so they can collect the overtime charge
            setPaymentDialogOpen(true);
          }
        }

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

  const ensureRazorpayPaymentLink = async (): Promise<string | null> => {
    // If we already have a Razorpay payment link URL, return it
    if (booking?.razorpay_payment_link_url) {
      return booking.razorpay_payment_link_url;
    }

    // Create a Razorpay Payment Link via API
    try {
      const res = await fetch("/api/payments/create-payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: id }),
      });
      const json = await res.json();
      if (res.ok && json.data?.payment_link_url) {
        // Update local booking state with the new link
        setBooking((prev) => prev ? { ...prev, razorpay_payment_link_url: json.data.payment_link_url, razorpay_payment_link_id: json.data.payment_link_id } : prev);
        return json.data.payment_link_url;
      } else {
        // Razorpay not enabled or failed — fall back to internal link
        console.warn("Razorpay payment link failed, falling back to internal link:", json.error);
        return null;
      }
    } catch {
      return null;
    }
  };

  const [paymentLinkSending, setPaymentLinkSending] = useState(false);
  const [paymentLinkSent, setPaymentLinkSent] = useState(false);

  const handleSendPaymentLink = async () => {
    setPaymentLinkSending(true);
    // Try to create Razorpay payment link first
    const razorpayUrl = await ensureRazorpayPaymentLink();

    const res = await fetch(`/api/bookings/${id}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment_link",
        razorpay_payment_link_url: razorpayUrl || undefined,
      }),
    });
    setPaymentLinkSending(false);
    if (res.ok) {
      setPaymentLinkSent(true);
      const customerEmail = booking?.lead?.email || booking?.guest_email || "customer";
      toast.success(`Payment link sent to ${customerEmail}`, {
        description: razorpayUrl
          ? "Customer will receive a Razorpay payment link via email. Payment status will update automatically once completed."
          : "Customer will receive an internal payment link via email.",
        duration: 6000,
      });
      // Start polling for payment status updates
      const pollInterval = setInterval(async () => {
        const refreshRes = await fetch(`/api/bookings/${id}`);
        if (refreshRes.ok) {
          const refreshJson = await refreshRes.json();
          if (refreshJson.data?.payment_status === "paid") {
            clearInterval(pollInterval);
            setBooking(refreshJson.data);
            toast.success("Payment received! Customer has completed the payment.", { duration: 8000 });
          }
        }
      }, 10000); // Poll every 10 seconds
      // Stop polling after 10 minutes
      setTimeout(() => clearInterval(pollInterval), 600000);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to send payment link");
    }
  };

  const handleCopyPaymentLink = async () => {
    if (!booking?.payment_token) { toast.error("No payment token"); return; }

    // Try to get Razorpay payment link first
    const razorpayUrl = await ensureRazorpayPaymentLink();
    const url = razorpayUrl || `${window.location.origin}/pay/${booking.payment_token}`;

    navigator.clipboard.writeText(url)
      .then(() => toast.success(razorpayUrl ? "Razorpay payment link copied" : "Payment link copied"))
      .catch(() => toast.error("Failed to copy"));
  };

  const handleDownloadReceipt = async () => {
    try {
      const res = await fetch(`/api/bookings/${id}/receipt`);
      if (!res.ok) { toast.error("Failed to generate receipt"); return; }
      const json = await res.json();
      const rd = json.data;
      const b = rd.booking;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spaceName = (b.space as any)?.name || "—";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = b.lead as any;
      const customerName = b.guest_name || (lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Walk-in");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loc = b.location as any;
      const locationStr = loc ? `${loc.name}${loc.address ? ", " + loc.address : ""}${loc.city ? ", " + loc.city : ""}` : "";
      const dateStr = new Date(b.booking_date).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
      const startStr = b.start_time?.slice(0, 5);
      const endStr = b.end_time?.slice(0, 5);
      const totalPaid = (rd.payments || []).reduce((s: number, p: { amount: number }) => s + p.amount, 0);

      const win = window.open("", "_blank");
      if (!win) { toast.error("Popup blocked — allow popups for this site"); return; }
      win.document.write(`
        <html><head><title>Receipt - ${b.booking_number}</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #1a1b1e; }
          h1 { color: #015E65; font-size: 24px; margin-bottom: 0; }
          .brand { color: #00AE6C; font-size: 13px; margin-top: 4px; }
          h2 { font-size: 15px; margin-top: 24px; color: #333; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
          table { width: 100%; border-collapse: collapse; margin: 8px 0; }
          td { padding: 5px 0; font-size: 14px; } .lbl { color: #666; width: 40%; } .val { font-weight: 500; }
          .amt { text-align: right; font-weight: 600; } .total-row td { border-top: 2px solid #015E65; padding-top: 10px; font-size: 16px; }
          .footer { margin-top: 40px; text-align: center; color: #999; font-size: 11px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
          @media print { body { margin: 0; } .no-print { display: none; } }
        </style></head><body>
        <h1>The WorkVilla</h1>
        <p class="brand">Booking Receipt</p>
        <hr/>
        <h2>Booking Details</h2>
        <table>
          <tr><td class="lbl">Booking #</td><td class="val">${b.booking_number}</td></tr>
          <tr><td class="lbl">Space</td><td class="val">${spaceName}</td></tr>
          ${locationStr ? `<tr><td class="lbl">Location</td><td class="val">${locationStr}</td></tr>` : ""}
          <tr><td class="lbl">Date</td><td class="val">${dateStr}</td></tr>
          <tr><td class="lbl">Time</td><td class="val">${startStr} – ${endStr}</td></tr>
          <tr><td class="lbl">Duration</td><td class="val">${formatDuration(Number(b.duration_hours))}</td></tr>
          <tr><td class="lbl">Customer</td><td class="val">${customerName}</td></tr>
          ${lead?.company ? `<tr><td class="lbl">Company</td><td class="val">${lead.company}</td></tr>` : ""}
        </table>
        <h2>Payment Summary</h2>
        <table>
          <tr><td class="lbl">Total Amount</td><td class="amt">₹${b.total_amount?.toLocaleString("en-IN")}</td></tr>
          ${(rd.payments || []).map((p: { amount: number; payment_mode: string }) =>
            `<tr><td class="lbl">${(p.payment_mode || "").toUpperCase()}</td><td class="amt">₹${p.amount.toLocaleString("en-IN")}</td></tr>`
          ).join("")}
          <tr class="total-row"><td class="lbl">Total Paid</td><td class="amt">₹${totalPaid.toLocaleString("en-IN")}</td></tr>
          ${b.total_amount - totalPaid > 0 ? `<tr><td class="lbl" style="color:#dc2626">Balance Due</td><td class="amt" style="color:#dc2626">₹${(b.total_amount - totalPaid).toLocaleString("en-IN")}</td></tr>` : ""}
        </table>
        ${rd.voucher_code ? `<p style="margin-top:16px;"><strong>WiFi Voucher:</strong> <code style="background:#f0faf5;padding:2px 8px;border-radius:4px;">${rd.voucher_code}</code></p>` : ""}
        <div class="footer">
          <p><strong>${rd.company.name}</strong></p>
          <p>${rd.company.brand} | ${rd.company.address}</p>
          <p>${rd.company.phone} | GST: ${rd.company.gst}</p>
        </div>
        <script>setTimeout(function(){ window.print(); }, 300);</script>
        </body></html>
      `);
      win.document.close();
    } catch {
      toast.error("Failed to generate receipt");
    }
  };

  // "Collect now anyway" — for contract-holder bookings whose default flow
  // posts the charge to next month's invoice. Some members prefer to settle
  // on the spot (cash, UPI, card). This flips the booking out of
  // posted_to_bill and waives the linked usage_charge from the monthly
  // statement, then opens the existing CollectPaymentDialog so the rest of
  // the workflow is unchanged.
  const handleConvertFromBill = async () => {
    if (!booking) return;
    const ok = window.confirm(
      "Convert this booking from monthly invoice to direct collection?\n\n" +
      "The charge will be removed from the next monthly statement and " +
      "you'll be prompted to collect payment now."
    );
    if (!ok) return;
    setConvertingFromBill(true);
    try {
      const res = await fetch(`/api/bookings/${id}/convert-from-bill`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to convert booking");
        return;
      }
      toast.success("Charge removed from monthly invoice — collect payment now");
      await fetchBooking();
      // Open the collect-payment dialog so finance can take payment immediately.
      setPaymentDialogOpen(true);
    } finally {
      setConvertingFromBill(false);
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
  // activeVoucher replaced by WifiVoucherCard which handles multi-voucher display
  const outstandingTotal = outstandingCharges.reduce((s, c) => s + c.total, 0);
  const canEditPricing = booking.status !== "cancelled";

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
          {/* Contract members can opt out of monthly invoicing for this
              one booking and pay on the spot. The button is intentionally
              limited to posted_to_bill state — once it's collected/paid,
              there's nothing to convert. */}
          {booking.customer_type === "contract_holder" &&
           booking.payment_status === "posted_to_bill" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleConvertFromBill}
              disabled={convertingFromBill}
              className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
              title="Take payment now instead of posting to monthly invoice"
            >
              {convertingFromBill
                ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                : <Banknote className="mr-1 h-4 w-4" />}
              Collect Now Anyway
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
              <Star className="mr-1 h-4 w-4 text-amber-500" />Rate Customer
            </Button>
          )}
          {/* Log Charge — available for checked-out and no-show bookings */}
          {(booking.status === "checked_out" || booking.status === "no_show") && (
            <Button variant="outline" size="sm" onClick={() => setLogChargeOpen(true)}>
              <Receipt className="mr-1 h-4 w-4" />Log Charge
            </Button>
          )}
          {/* Overtime waiver button — shown after checkout if overtime was detected */}
          {pendingOvertimeCharge && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWaiverOpen(true)}
              className="border-amber-300 text-amber-700 hover:bg-amber-50"
            >
              <ShieldCheck className="mr-1 h-4 w-4" />Request Overtime Waiver
            </Button>
          )}
          {actionLoading && <Loader2 className="h-4 w-4 animate-spin self-center" />}
        </div>
      </div>

      {/* Payment status summary — replaces the bare "posted_to_bill" pill
          with a finance-friendly banner that names the contract, the
          target invoice month, the method (when paid), free-quota math
          (when applicable), or the prepaid pack source. */}
      <BookingPaymentSummary booking={booking} variant="full" />

      {/* Outstanding charges from previous bookings */}
      {outstandingCharges.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-amber-800">
              Outstanding charges from previous visits — {formatCurrency(outstandingTotal)}
            </p>
            <p className="text-sm text-amber-700 mb-2">
              {customerName} has {outstandingCharges.length} unpaid charge{outstandingCharges.length > 1 ? "s" : ""} logged against past bookings.
            </p>
            <div className="space-y-1">
              {outstandingCharges.map((c) => (
                <div key={c.id}>
                  <div className="flex items-center justify-between text-sm bg-white/70 rounded px-3 py-1.5 border border-amber-100">
                    <button type="button" className="flex-1 text-left text-amber-900 hover:underline" onClick={() => setExpandedChargeId(expandedChargeId === c.id ? null : c.id)}>
                      {c.description}
                    </button>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      {c.booking && (
                        <Link href={`/bookings/${c.booking.booking_number}`} className="text-xs text-amber-600 font-mono hover:underline" title="View original booking">
                          {c.booking.booking_number}
                        </Link>
                      )}
                      <span className="font-semibold text-amber-800">{formatCurrency(c.total)}</span>
                      <button
                        type="button"
                        className="text-xs text-green-700 hover:text-green-900 underline font-medium"
                        title="Mark as collected in this booking"
                        onClick={async () => {
                          const res = await fetch(`/api/usage-charges/${c.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ settled_in_booking_id: id }),
                          });
                          if (res.ok) {
                            toast.success("Charge marked as collected");
                            setOutstandingCharges(prev => prev.filter(ch => ch.id !== c.id));
                          } else {
                            const err = await res.json().catch(() => null);
                            toast.error(err?.error || "Failed to settle charge");
                          }
                        }}
                      >
                        Collect
                      </button>
                      {(userRole === "admin" || userRole === "manager") && (
                        <button
                          type="button"
                          className="text-xs text-red-600 hover:text-red-800 underline ml-1"
                          onClick={async () => {
                            const reason = window.prompt("Reason for waiving this charge:");
                            if (reason === null) return;
                            const res = await fetch(`/api/usage-charges/${c.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ status: "waived", waive_reason: reason }),
                            });
                            if (res.ok) {
                              toast.success("Charge waived");
                              setOutstandingCharges(prev => prev.filter(ch => ch.id !== c.id));
                            } else {
                              const err = await res.json().catch(() => null);
                              toast.error(err?.error || "Failed to waive");
                            }
                          }}
                        >
                          Waive
                        </button>
                      )}
                    </div>
                  </div>
                  {expandedChargeId === c.id && (
                    <div className="ml-4 mt-1 mb-2 p-3 bg-white rounded border border-amber-100 text-xs space-y-1.5">
                      {c.booking && (
                        <p>
                          <span className="text-muted-foreground">Original booking:</span>{" "}
                          <Link href={`/bookings/${c.booking.booking_number}`} className="text-primary underline font-mono">
                            {c.booking.booking_number}
                          </Link>{" "}
                          <span className="text-muted-foreground">({formatDate(c.booking.booking_date)})</span>
                        </p>
                      )}
                      {c.charge_date && <p><span className="text-muted-foreground">Charged on:</span> {formatDate(c.charge_date)}</p>}
                      {c.quantity && c.unit_price ? <p><span className="text-muted-foreground">Breakdown:</span> {c.quantity} × {formatCurrency(c.unit_price)} = {formatCurrency(c.total)}</p> : null}
                      {c.notes && <p><span className="text-muted-foreground">Reason:</span> {c.notes}</p>}
                      {c.proof_path && (
                        <p>
                          <a href={`/api/documents/view?path=${encodeURIComponent(c.proof_path)}`} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                            View Proof Photo
                          </a>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Payment Collected Success Banner */}
      {booking.payment_status === "paid" && (() => {
        const razorpayPayment = existingPayments.find(p => p.payment_mode === "razorpay" && p.status === "verified");
        return (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
            <div className="flex-shrink-0 w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <CheckCircle className="h-7 w-7 text-green-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-green-800">Payment Collected Successfully</p>
              <p className="text-sm text-green-600">
                {formatCurrency(Number(booking.total_amount_with_gst) || booking.total_amount)} paid via {(booking.payment_mode && PAYMENT_MODE_LABELS[booking.payment_mode]) || booking.payment_mode || "online payment"}
                {booking.status === "confirmed" && " — Ready for check-in"}
              </p>
              {razorpayPayment && (
                <div className="mt-2 text-xs text-green-700 space-y-0.5">
                  {razorpayPayment.razorpay_payment_id && (
                    <p>Razorpay Payment ID: <span className="font-mono">{razorpayPayment.razorpay_payment_id}</span></p>
                  )}
                  {razorpayPayment.razorpay_order_id && (
                    <p>Order ID: <span className="font-mono">{razorpayPayment.razorpay_order_id}</span></p>
                  )}
                  <p>Confirmed: {formatDateTime(razorpayPayment.created_at)}</p>
                </div>
              )}
            </div>
            {booking.status === "confirmed" && (
              <Button size="sm" className="flex-shrink-0" onClick={() => handleStatusAction("check_in")} disabled={actionLoading}>
                <LogIn className="mr-1 h-4 w-4" />Check In Now
              </Button>
            )}
          </div>
        );
      })()}

      {/* Quick Action Links */}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleDownloadReceipt}>
          <Download className="mr-1 h-3.5 w-3.5" />Download Receipt
        </Button>
        {booking.status === "checked_out" && (
          <>
            {booking.feedback_token && (
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleCopyFeedbackLink}>
                <Copy className="mr-1 h-3.5 w-3.5" />Copy Feedback Link
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={() => {
                const email = booking.lead?.email || booking.guest_email;
                if (!email) {
                  toast.error("No customer email on file — add email to the lead before sending feedback");
                  return;
                }
                handleSendFeedbackLink();
              }}
            >
              <MessageCircle className="mr-1 h-3.5 w-3.5" />Send Feedback Link
            </Button>
          </>
        )}
        {booking.payment_status !== "paid" && booking.payment_token && (
          <>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleCopyPaymentLink}>
              <Link2 className="mr-1 h-3.5 w-3.5" />Copy Payment Link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={handleSendPaymentLink}
              disabled={paymentLinkSending}
            >
              {paymentLinkSending ? (
                <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Sending...</>
              ) : (
                <><Mail className="mr-1 h-3.5 w-3.5" />Send Payment Link</>
              )}
            </Button>
            {paymentLinkSent && (
              <Badge variant="outline" className="text-[10px] border-blue-300 text-blue-700 bg-blue-50 animate-pulse">
                ⏳ Awaiting payment…
              </Badge>
            )}
          </>
        )}
      </div>

      {/* Booking Lifecycle Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Booking Lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <BookingLifecycleTimeline booking={booking} />
        </CardContent>
      </Card>

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
              <span>{formatDuration(Number(booking.duration_hours))}</span>
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
            {/* GST Number — inline editable */}
            {booking.lead_id && (
              <div className="flex justify-between items-start">
                <span className="text-muted-foreground">GST Number</span>
                {editingGst ? (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1">
                      <Input
                        value={draftGst}
                        onChange={(e) => {
                          const v = e.target.value.toUpperCase();
                          setDraftGst(v);
                          if (v && !GST_REGEX.test(v)) {
                            setGstError("Format: 33AAAAA0000A1Z5");
                          } else {
                            setGstError(null);
                          }
                        }}
                        placeholder="33AAAAA0000A1Z5"
                        maxLength={15}
                        className="h-7 w-40 text-right text-sm uppercase"
                        disabled={gstSaving}
                        autoFocus
                      />
                      <button onClick={handleGstSave} disabled={gstSaving} className="text-green-600 hover:text-green-700" title="Save">
                        {gstSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      </button>
                      <button onClick={() => { setEditingGst(false); setGstError(null); }} disabled={gstSaving} className="text-muted-foreground hover:text-foreground" title="Cancel">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {gstError && <p className="text-xs text-red-500">{gstError}</p>}
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs">{booking.lead?.gst_number || <span className="text-muted-foreground italic">Not provided</span>}</span>
                    <button
                      onClick={() => { setDraftGst(booking.lead?.gst_number || ""); setEditingGst(true); }}
                      className="text-muted-foreground hover:text-foreground ml-1"
                      title="Edit GST number"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Financials */}
        <Card>
          <CardHeader><CardTitle className="text-sm">Financials</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {/* Pricing-model indicator (label only — value editor below stays unchanged) */}
            {booking.pricing_model === "daily" && (
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/30 rounded px-2 py-1">
                Day pass · 1 × day rate (×{Number(booking.quantity ?? 1)})
              </div>
            )}
            {/* Rate — inline editable */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">{booking.pricing_model === "daily" ? "Day Rate" : "Hourly Rate"}</span>
              {editingPricing ? (
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draftRate}
                  onChange={(e) => {
                    setDraftRate(e.target.value);
                    const newRate = parseFloat(e.target.value);
                    if (!isNaN(newRate) && newRate >= 0) {
                      const facilityCharges =
                        Number(booking.total_amount) -
                        Number(booking.hourly_rate) * Number(booking.duration_hours);
                      setDraftTotal((newRate * Number(booking.duration_hours) + facilityCharges).toFixed(2));
                    }
                  }}
                  className="h-7 w-28 text-right text-sm"
                  disabled={pricingSaving}
                  autoFocus
                />
              ) : (
                <div className="flex items-center gap-1">
                  <span>{formatCurrency(booking.hourly_rate)}</span>
                  {canEditPricing && (
                    <button
                      onClick={() => {
                        setDraftRate(Number(booking.hourly_rate).toFixed(2));
                        setDraftTotal(Number(booking.total_amount).toFixed(2));
                        setEditingPricing(true);
                      }}
                      className="text-muted-foreground hover:text-foreground ml-1"
                      title="Edit pricing"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* GST breakdown */}
            {booking.gst_rate && booking.gst_amount ? (
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>GST ({booking.gst_rate}%)</span>
                <span>{formatCurrency(booking.gst_amount)}</span>
              </div>
            ) : null}

            {/* Total Amount — auto-recalculated or direct override */}
            <div className="flex justify-between items-center font-medium">
              <span className="text-muted-foreground">Total (incl. GST)</span>
              {editingPricing ? (
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draftTotal}
                  onChange={(e) => setDraftTotal(e.target.value)}
                  className="h-7 w-28 text-right text-sm"
                  disabled={pricingSaving}
                />
              ) : (
                <span>{formatCurrency(Number(booking.total_amount_with_gst) || booking.total_amount)}</span>
              )}
            </div>

            {/* Save / Cancel — only visible during edit */}
            {editingPricing && (
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setEditingPricing(false)}
                  disabled={pricingSaving}
                >
                  <X className="h-3 w-3 mr-1" />Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs bg-teal-600 hover:bg-teal-700 text-white"
                  onClick={handlePricingSave}
                  disabled={pricingSaving}
                >
                  {pricingSaving
                    ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    : <Check className="h-3 w-3 mr-1" />}
                  Save
                </Button>
              </div>
            )}

            {/* Payment summary from booking_payments */}
            {(() => {
              const verifiedTotal = existingPayments
                .filter((p) => p.status === "verified")
                .reduce((sum, p) => sum + Number(p.amount), 0);
              const pendingTotal = existingPayments
                .filter((p) => p.status === "pending")
                .reduce((sum, p) => sum + Number(p.amount), 0);
              const chargeableTotal = Number(booking.total_amount_with_gst) || Number(booking.total_amount);
              const balanceDue = Math.max(0, chargeableTotal - verifiedTotal);

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
                <div className="space-y-2">
                  {existingPayments.map((p) => (
                    <div key={p.id} className="text-xs bg-muted/30 rounded px-2.5 py-2">
                      <div className="flex items-center justify-between">
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
                      {/* Razorpay confirmation details */}
                      {p.payment_mode === "razorpay" && (p.razorpay_payment_id || p.razorpay_order_id) && (
                        <div className="mt-1.5 pt-1.5 border-t border-muted/50 text-[11px] text-muted-foreground space-y-0.5">
                          {p.razorpay_payment_id && (
                            <div className="flex justify-between">
                              <span>Payment ID</span>
                              <span className="font-mono">{p.razorpay_payment_id}</span>
                            </div>
                          )}
                          {p.razorpay_order_id && (
                            <div className="flex justify-between">
                              <span>Order ID</span>
                              <span className="font-mono">{p.razorpay_order_id}</span>
                            </div>
                          )}
                          {p.payment_reference && p.payment_reference !== p.razorpay_payment_id && (
                            <div className="flex justify-between">
                              <span>Reference</span>
                              <span className="font-mono">{p.payment_reference}</span>
                            </div>
                          )}
                        </div>
                      )}
                      {/* Non-Razorpay reference */}
                      {p.payment_mode !== "razorpay" && p.payment_reference && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Ref: <span className="font-mono">{p.payment_reference}</span>
                        </div>
                      )}
                      <div className="mt-1 text-[10px] text-muted-foreground/70">
                        {formatDateTime(p.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>


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

        {/* WiFi Vouchers — multi-voucher display */}
        <WifiVoucherCard
          booking={booking}
          existingIssuances={booking.voucher_issuances || []}
          onIssued={fetchBooking}
        />

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

        {/* Customer Review (submitted via feedback link) */}
        {booking.customer_feedback
          ? <CustomerReviewCard feedback={booking.customer_feedback} />
          : booking.status === "checked_out" && (
            <Card className="border-dashed">
              <CardContent className="py-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Star className="h-4 w-4 text-amber-400" />
                  Waiting for customer review
                </div>
                <div className="flex items-center gap-2">
                  {booking.feedback_token && (
                    <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleCopyFeedbackLink}>
                      <Copy className="mr-1 h-3 w-3" />Copy Link
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => {
                    if (!booking.lead?.email && !booking.guest_email) {
                      toast.error("No customer email on file");
                      return;
                    }
                    handleSendFeedbackLink();
                  }}>
                    <Mail className="mr-1 h-3 w-3" />Resend Email
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        }

        {/* Staff Rating */}
        {booking.feedback && (
          <StaffFeedbackCard feedback={booking.feedback} />
        )}
      </div>

      {/* Add-ons / extras — lazy-mounted so the catalog fetch and dialog don't
          run on every page load. The section mounts the first time the user
          clicks "Add charge" (or automatically on checkout overtime). */}
      {booking.space_id && (
        showAddonsSection ? (
          <BookingAddonsSection
            bookingId={booking.id}
            spaceId={booking.space_id}
            canEdit={booking.status !== "cancelled"}
            onChange={fetchBooking}
            prefill={addonPrefill}
            openSignal={addonOpenSignal}
          />
        ) : (
          <div className="rounded-lg border bg-card p-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Extras &amp; charges</h3>
              <p className="text-xs text-muted-foreground">Add-ons and additional charges</p>
            </div>
            {booking.status !== "cancelled" && (
              <Button
                size="sm"
                onClick={() => {
                  setShowAddonsSection(true);
                  // Use Date.now() so the openSignal effect in the section
                  // (which guards on truthiness) fires after mount.
                  setAddonOpenSignal(Date.now());
                }}
              >
                <Plus className="h-4 w-4 mr-1" />Add charge
              </Button>
            )}
          </div>
        )
      )}

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
          {booking.aggregator_booking_id && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Aggregator Ref</span>
              <span className="font-mono text-xs">{booking.aggregator_booking_id}</span>
            </div>
          )}
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
        bookingReference={booking.booking_number || ""}
        totalAmount={Number(booking.total_amount_with_gst) || Number(booking.total_amount)}
        onSuccess={fetchBooking}
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

      <AddUsageChargeDialog
        open={logChargeOpen}
        onOpenChange={setLogChargeOpen}
        onSuccess={fetchBooking}
        bookingId={booking.id}
      />

      {pendingOvertimeCharge && (
        <WaiverRequestDialog
          open={waiverOpen}
          onOpenChange={setWaiverOpen}
          bookingId={booking.id}
          waiverType="overtime"
          waiverAmount={pendingOvertimeCharge.charge}
          onApproved={() => {
            setPendingOvertimeCharge(null);
            fetchBooking();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WiFi Voucher card — handles both multi-voucher display (walk-in/guest)
// and on-demand issuance button (contract holders with invited guests).
// ---------------------------------------------------------------------------

interface VoucherIssuance {
  id?: string;
  is_active: boolean;
  voucher?: { voucher_code: string } | null;
}

function WifiVoucherCard({
  booking,
  existingIssuances,
  onIssued,
}: {
  booking: Booking;
  existingIssuances: VoucherIssuance[];
  onIssued: () => void;
}) {
  const [requesting, setRequesting] = useState(false);
  const activeIssuances = existingIssuances.filter((v) => v.is_active && v.voucher?.voucher_code);

  const numAttendees = booking.num_attendees ?? null;
  const vouchersNeeded = numAttendees ? Math.ceil(numAttendees / 2) : 1;
  const shortfall = Math.max(0, vouchersNeeded - activeIssuances.length);

  const handleRequestVouchers = async () => {
    setRequesting(true);
    const res = await fetch(`/api/bookings/${booking.id}/vouchers`, { method: "POST" });
    const json = await res.json();
    if (res.ok) {
      toast.success(`${json.issued} WiFi voucher${json.issued !== 1 ? "s" : ""} issued`);
      if (json.shortfall > 0) {
        toast.warning(`${json.shortfall} voucher${json.shortfall !== 1 ? "s" : ""} could not be issued — stock is low. Top up inventory.`);
      }
      onIssued();
    } else {
      toast.error(json.error || "Failed to issue vouchers");
    }
    setRequesting(false);
  };

  // Contract holder — no auto-issued vouchers
  if (booking.customer_type === "contract_holder") {
    if (activeIssuances.length === 0) {
      // Only offer the button for active bookings
      if (!["confirmed", "checked_in"].includes(booking.status)) return null;
      return (
        <Card className="border-dashed">
          <CardContent className="py-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wifi className="h-4 w-4" />
              <span>No WiFi vouchers issued — guests attending?</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRequestVouchers}
              disabled={requesting}
            >
              {requesting ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Issuing…</> : <><Wifi className="h-3.5 w-3.5 mr-1" />Issue Vouchers</>}
            </Button>
          </CardContent>
        </Card>
      );
    }
  }

  // No vouchers at all — nothing to show for walk-in/guest (shouldn't normally happen)
  if (activeIssuances.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          WiFi Vouchers
          <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
            {activeIssuances.length}{numAttendees ? ` / ${vouchersNeeded} needed` : ""} issued
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {activeIssuances.length === 1 ? (
          // Single voucher — keep the original prominent display
          <div>
            <p className="font-mono text-lg font-bold tracking-wider text-center py-1">
              {activeIssuances[0].voucher!.voucher_code}
            </p>
            <p className="text-xs text-muted-foreground text-center">2 device logins · valid for 24 hours</p>
          </div>
        ) : (
          // Multiple vouchers — numbered list
          <div className="space-y-1.5">
            {activeIssuances.map((v, idx) => (
              <div key={v.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
                <span className="text-xs text-muted-foreground">Voucher {idx + 1}</span>
                <span className="font-mono text-sm font-semibold tracking-wider">
                  {v.voucher!.voucher_code}
                </span>
              </div>
            ))}
            <p className="text-xs text-muted-foreground pt-1 text-center">
              Each code supports 2 device logins · valid for 24 hours
            </p>
          </div>
        )}

        {/* Low-stock warning when fewer vouchers issued than attendees need */}
        {shortfall > 0 && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700 flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {shortfall} voucher{shortfall !== 1 ? "s" : ""} short — only {activeIssuances.length} available in stock for {numAttendees} attendees. Top up inventory.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Customer-friendly labels for the public dimensions
const CUSTOMER_DIMENSION_LABELS: Record<string, string> = {
  space_etiquette:    "Cleanliness & Ambiance",
  payment_discipline: "Service Quality",
  community_behavior: "Staff Friendliness",
  guest_management:   "Facilities & Amenities",
  resource_usage:     "Value for Money",
  renewal_likelihood: "Would Return?",
};

function sentimentInfo(rating: number) {
  if (rating >= 4) return { label: "Positive",  className: "bg-green-100 text-green-800" };
  if (rating >= 3) return { label: "Neutral",   className: "bg-amber-100 text-amber-800" };
  return               { label: "Negative",  className: "bg-red-100 text-red-800"   };
}

function StarRow({ value }: { value: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <Star key={s} className={`h-3.5 w-3.5 ${s <= value ? "fill-amber-400 text-amber-400" : "fill-none text-gray-200"}`} />
      ))}
    </div>
  );
}

function CustomerReviewCard({ feedback }: { feedback: BookingFeedback }) {
  const rating = feedback.overall_rating ?? 0;
  const s = sentimentInfo(rating);
  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Star className="h-4 w-4 text-blue-500" />
          Customer Review
          {rating > 0 && (
            <>
              <Badge variant="secondary" className={s.className}>{s.label}</Badge>
              <span className="text-xs text-muted-foreground ml-auto">{rating.toFixed(1)} / 5</span>
            </>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm">
        {Object.keys(CUSTOMER_DIMENSION_LABELS).map(key => {
          const val = feedback[key as keyof BookingFeedback] as number | null;
          if (val == null) return null;
          return (
            <div key={key} className="flex items-center justify-between">
              <span className="text-muted-foreground">{CUSTOMER_DIMENSION_LABELS[key]}</span>
              <StarRow value={val} />
            </div>
          );
        })}
        {feedback.notes && (
          <>
            <Separator />
            <div>
              <span className="text-muted-foreground text-xs">Their comment</span>
              <p className="mt-0.5 whitespace-pre-wrap text-sm italic">&ldquo;{feedback.notes}&rdquo;</p>
            </div>
          </>
        )}
        <div className="text-xs text-muted-foreground pt-1 border-t">
          Submitted by customer on {formatDate(feedback.created_at)}
        </div>
      </CardContent>
    </Card>
  );
}

function StaffFeedbackCard({ feedback }: { feedback: BookingFeedback }) {
  const rating = feedback.overall_rating ?? 0;
  const s = sentimentInfo(rating);
  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500" />
          Staff Rating
          {rating > 0 && (
            <>
              <Badge variant="secondary" className={s.className}>{s.label}</Badge>
              <span className="text-xs text-muted-foreground ml-auto">{rating.toFixed(1)} / 5</span>
            </>
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
              <StarRow value={val} />
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

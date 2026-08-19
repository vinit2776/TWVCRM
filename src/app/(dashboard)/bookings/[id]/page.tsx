"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, LogIn, LogOut, XCircle, Mail, Loader2,
  IndianRupee, Wifi,
  Phone, AlertTriangle, ShieldCheck, Star,
  Banknote, CheckCircle, Calendar, Timer, Copy, Coins, Gift,
  Download, MessageCircle, Repeat,
  StickyNote, Pencil, Check, X, Plus, Share2, KeyRound, Send, DoorOpen, Building2,
  Activity, ShieldAlert, ImageIcon, FileText, RotateCw,
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
const DeferBookingDialog     = dynamic(() => import("@/components/bookings/defer-booking-dialog").then(m => m.DeferBookingDialog),         { ssr: false });
const SharePaymentLinkDialog = dynamic(() => import("@/components/bookings/share-payment-link-dialog").then(m => m.SharePaymentLinkDialog), { ssr: false });
const PostCheckoutChecklistDialog = dynamic(() => import("@/components/bookings/post-checkout-checklist-dialog").then(m => m.PostCheckoutChecklistDialog), { ssr: false });
const CancelBookingDialog    = dynamic(() => import("@/components/bookings/cancel-booking-dialog").then(m => m.CancelBookingDialog),         { ssr: false });
const MarkComplimentaryDialog = dynamic(() => import("@/components/bookings/mark-complimentary-dialog").then(m => m.MarkComplimentaryDialog), { ssr: false });
const GetPaymentChooser      = dynamic(() => import("@/components/bookings/get-payment-chooser").then(m => m.GetPaymentChooser),             { ssr: false });
import { NextActionBanner, NextActionTarget, computeNextActionTarget } from "@/components/bookings/next-action-banner";
import { OvertimeChargeBanner } from "@/components/bookings/overtime-charge-banner";
import { TransactionSummary, type TxnAddon } from "@/components/bookings/transaction-summary";
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
import { createClient } from "@/lib/supabase/client";

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
  const [booking, setBooking] = useState<Booking & {
    voucher_seat_cap?: number;
    voucher_issuances?: {
      id?: string;
      voucher?: { voucher_code: string } | null;
      is_active: boolean;
      issued_at?: string | null;
      unifi_code?: string | null;
      unifi_voucher_id?: string | null;
      ruijie_code?: string | null;
      ruijie_voucher_uuid?: string | null;
      emailed_at?: string | null;
      duration_minutes?: number | null;
      seat_occupant_email?: string | null;
      revoked_at?: string | null;
      revoke_reason?: string | null;
    }[]
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [rescheduleDialogOpen, setRescheduleDialogOpen] = useState(false);
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [deferDialogOpen, setDeferDialogOpen] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [getPaymentChooserOpen, setGetPaymentChooserOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [markCompDialogOpen, setMarkCompDialogOpen] = useState(false);
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
  // Post-checkout usage charges linked to THIS booking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [bookingCharges, setBookingCharges] = useState<any[]>([]);
  // Add-ons, fetched up-front so the Transaction Summary can total them.
  const [bookingAddons, setBookingAddons] = useState<TxnAddon[]>([]);
  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;
  const [bookingDevices, setBookingDevices] = useState<Array<{ id: string; device: { id: string; label: string; device_category: string } | null }>>([]);
  const [pinDelivery, setPinDelivery] = useState<{ whatsapp: string; sms: string; email: string; at?: string } | null>(null);
  const [pinCopied, setPinCopied] = useState(false);
  const [accessLogs, setAccessLogs] = useState<Array<{
    id: string;
    direction: string;
    event_time: string;
    device: { id: string; label: string; device_code: string | null; device_category: string } | null;
  }>>([]);

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

  // Comp approval request state — fetched alongside booking data
  const [compRequest, setCompRequest] = useState<import("@/components/bookings/booking-lifecycle-timeline").CompRequestData | null>(null);

  // Payment records + gateway config
  const [existingPayments, setExistingPayments] = useState<BookingPayment[]>([]);
  const [upiId, setUpiId] = useState("");
  const [upiQrCodePath, setUpiQrCodePath] = useState("");
  const [zoomedScreenshotUrl, setZoomedScreenshotUrl] = useState<string | null>(null);
  const [loadingScreenshotId, setLoadingScreenshotId] = useState<string | null>(null);

  // AbortController ref — cancels in-flight requests on unmount / re-fetch
  const fetchControllerRef = useRef<AbortController | null>(null);

  const handleViewPaymentScreenshot = useCallback(async (paymentId: string, screenshotPath: string) => {
    setLoadingScreenshotId(paymentId);
    try {
      const supabase = createClient();
      const { data } = await supabase.storage
        .from("crm-documents")
        .createSignedUrl(screenshotPath, 3600);
      if (data?.signedUrl) setZoomedScreenshotUrl(data.signedUrl);
    } finally {
      setLoadingScreenshotId(null);
    }
  }, []);

  const fetchBooking = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);

    // Wave 1: booking (needed for leadId) + payments + booking charges + settings + devices + access logs + addons — parallel.
    // Addons are fetched here (not only lazily by BookingAddonsSection) because
    // the Transaction Summary needs them to compute the grand total on load.
    const [bookingRes, paymentsRes, bcRes, settingsRes, devicesRes, logsRes, addonsRes] = await Promise.all([
      fetch(`/api/bookings/${id}`, { signal }),
      fetch(`/api/booking-payments?booking_id=${id}`, { signal }),
      fetch(`/api/usage-charges?booking_id=${id}`, { signal }),
      fetch("/api/settings/public", { signal }),
      fetch(`/api/cosec/booking-devices?booking_id=${id}`, { signal }),
      fetch(`/api/cosec/access-logs?booking_id=${id}`, { signal }),
      fetch(`/api/bookings/${id}/addons`, { signal }),
    ]).catch((e) => {
      if ((e as Error).name === "AbortError") return [null, null, null, null, null, null, null] as const;
      throw e;
    });
    if (signal?.aborted) return;

    let leadId: string | null = null;
    if (bookingRes?.ok) {
      const json = await bookingRes.json();
      setBooking(json.data || null);
      leadId = json.data?.lead_id ?? null;
      // Populate delivery status for automatically-provisioned PINs (booking creation,
      // payment webhook). null means no pin_delivery audit row exists yet — expected for
      // historical bookings, so leave pinDelivery unset rather than rendering a false badge.
      // A manual re-provision (provisionPin() below) sets pinDelivery itself right after
      // this fetch resolves, so it always wins over what was loaded here.
      const loadedPinDelivery = json.data?.pin_delivery as
        { whatsapp: string; sms: string; email: string; at: string } | null | undefined;
      if (loadedPinDelivery) setPinDelivery(loadedPinDelivery);
    }
    if (paymentsRes?.ok) {
      const pJson = await paymentsRes.json();
      setExistingPayments(pJson.data || []);
    }
    if (bcRes?.ok) {
      const bcJson = await bcRes.json();
      setBookingCharges(bcJson.data || []);
    }
    if (settingsRes?.ok) {
      const sJson = await settingsRes.json();
      const settings = sJson.data || {};
      setUpiId(settings.upi_id || "");
      setUpiQrCodePath(settings.upi_qr_code_path || "");
    }
    if (devicesRes?.ok) {
      const dJson = await devicesRes.json();
      setBookingDevices(dJson.data || []);
    }
    if (logsRes?.ok) {
      const lJson = await logsRes.json();
      setAccessLogs(lJson.data || []);
    }
    if (addonsRes?.ok) {
      const aJson = await addonsRes.json();
      setBookingAddons(aJson.data || []);
    }

    // Wave 2: outstanding charges (needs leadId from Wave 1)
    if (leadId && !signal?.aborted) {
      try {
        const ocRes = await fetch(
          `/api/usage-charges?lead_id=${leadId}&status=pending&limit=50`,
          { signal },
        );
        if (ocRes.ok) {
          const ocJson = await ocRes.json();
          const bookingCharges = (ocJson.data || []).filter(
            (c: { booking_id?: string | null }) =>
              c.booking_id && c.booking_id !== id
          );
          setOutstandingCharges(bookingCharges);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }

    if (!signal?.aborted) setLoading(false);
  }, [id]);

  /** Fetch the latest comp request for this booking (if any). */
  const fetchCompRequest = useCallback(async () => {
    try {
      const res = await fetch(`/api/bookings/${id}/comp-request`);
      if (res.ok) {
        const json = await res.json();
        setCompRequest(json.data ?? null);
      }
    } catch { /* silent — non-critical */ }
  }, [id]);

  useEffect(() => {
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    fetchBooking(controller.signal);
    fetchCompRequest();
    return () => controller.abort();
  }, [fetchBooking, fetchCompRequest]);

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

        // Show overtime alert if applicable. Contract-holder overtime is
        // handled separately — the checkout API posts a real usage_charge
        // for that case and returns overtime: null, so this ephemeral
        // toast/dialog path only ever applies to day-pass and walk-in/guest
        // bookings (unchanged behavior for those).
        if (resJson.overtime && booking?.customer_type !== "contract_holder") {
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

  // Fired when CollectPaymentDialog records a payment. The create-time confirmation
  // email is skipped in new/page.tsx when the flow redirects here to collect payment
  // (payment_status is still "pending" at create time), so this is where that
  // confirmation actually goes out. Sent unconditionally: the email route derives
  // payment state from the live booking_payments rows at send time, so it renders
  // accurately whether the booking ended up paid, part-paid, or unpaid. Gating on
  // "paid" here would leave an abandoned payment with no confirmation email at all,
  // since the dialog also calls onSuccess when closed without recording anything.
  const handlePaymentRecorded = useCallback(() => {
    fetchBooking();
    fetch(`/api/bookings/${id}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "confirmation" }),
    }).catch(() => {});
  }, [fetchBooking, id]);

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

  const handleCopyBookingDetails = () => {
    if (!booking) return;
    const customerName = booking.lead
      ? `${booking.lead.first_name} ${booking.lead.last_name}`
      : booking.guest_name || "Guest";
    const customerPhone = booking.booker_phone || booking.guest_phone || booking.lead?.phone || booking.lead?.mobile || "";
    const company = booking.lead?.company || booking.guest_company || "";

    const lines: string[] = [
      `Booking Confirmation - ${booking.booking_number}`,
      ``,
      `Date: ${formatDate(booking.booking_date)}`,
      `Time: ${formatTime12(booking.start_time)} - ${formatTime12(booking.end_time)} (${booking.duration_hours}h)`,
      `Space: ${booking.space?.name || "—"}`,
      `Location: ${booking.location?.name || "—"}`,
    ];
    if (booking.location?.address) {
      lines.push(`Address: ${booking.location.address}${booking.location.city ? `, ${booking.location.city}` : ""}`);
    }

    lines.push(``);
    lines.push(`Customer: ${customerName}`);
    if (company) lines.push(`Company: ${company}`);
    if (customerPhone) lines.push(`Phone: ${customerPhone}`);
    if (booking.lead?.email || booking.guest_email) lines.push(`Email: ${booking.lead?.email || booking.guest_email}`);

    lines.push(``);
    lines.push(`Amount: ${formatCurrency(booking.total_amount)}${booking.gst_amount ? ` + ${formatCurrency(booking.gst_amount)} GST = ${formatCurrency(booking.total_amount_with_gst || booking.total_amount + booking.gst_amount)}` : ""}`);
    lines.push(`Payment: ${BOOKING_PAYMENT_STATUS_LABELS[booking.payment_status]}`);
    lines.push(`Status: ${BOOKING_STATUS_LABELS[booking.status]}`);

    if (booking.facilities && booking.facilities.length > 0) {
      lines.push(``);
      lines.push(`Add-ons: ${booking.facilities.map(f => f.facility_name).join(", ")}`);
    }

    lines.push(``);
    lines.push(`Booking Type: ${BOOKING_CUSTOMER_TYPE_LABELS[booking.customer_type]}`);
    if (booking.contract?.contract_number) {
      lines.push(`Agreement: ${booking.contract.contract_number}`);
    }
    if (booking.notes) {
      lines.push(`Notes: ${booking.notes}`);
    }

    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      toast.success("Booking details copied to clipboard");
    }).catch(() => {
      toast.error("Failed to copy details");
    });
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

  // Ensures a Razorpay Payment Link exists for this booking; creates one
  // if not. Used by both Copy Payment Link (clipboard) and the multi-
  // channel Send Payment Link dialog. The link is transaction-specific
  // — Razorpay assigns a unique payment_link_id and our /api/payments
  // /webhook flips the booking to "paid" automatically when the
  // customer completes payment, regardless of which method they pick on
  // the Razorpay page (card / netbanking / wallet — UPI is disabled
  // gateway-side at the moment but the rest of the methods work fine).
  const ensureRazorpayPaymentLink = async (): Promise<string | null> => {
    if (booking?.razorpay_payment_link_url) {
      return booking.razorpay_payment_link_url;
    }
    try {
      const res = await fetch("/api/payments/create-payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: id }),
      });
      const json = await res.json();
      if (res.ok && json.data?.payment_link_url) {
        setBooking((prev) => prev ? {
          ...prev,
          razorpay_payment_link_url: json.data.payment_link_url,
          razorpay_payment_link_id: json.data.payment_link_id,
        } : prev);
        return json.data.payment_link_url;
      } else {
        // Razorpay disabled or temporary failure — fall back to the
        // internal /pay/[token] link so collection isn't blocked.
        console.warn("Razorpay payment link failed, falling back to internal link:", json.error);
        return null;
      }
    } catch {
      return null;
    }
  };

  // The "awaiting payment…" badge shows once a link has been shared
  // through any channel. Sending state is local to the SharePaymentLinkDialog.
  const [paymentLinkSent, setPaymentLinkSent] = useState(false);
  const [paymentSendDialogOpen, setPaymentSendDialogOpen] = useState(false);

  // Kept available even though the standalone Copy Payment Link button
  // is folded into the SharePaymentLinkDialog. Leaving the helper here
  // so a future direct-copy entry point can reuse it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleCopyPaymentLink = async () => {
    if (!booking?.payment_token) { toast.error("No payment token"); return; }
    const razorpayUrl = await ensureRazorpayPaymentLink();
    const url = razorpayUrl || `${window.location.origin}/pay/${booking.payment_token}`;
    navigator.clipboard.writeText(url)
      .then(() => toast.success(razorpayUrl ? "Razorpay payment link copied" : "Payment link copied"))
      .catch(() => toast.error("Failed to copy"));
  };

  // Begin the once-every-10-seconds payment-status poll. Called after
  // the customer has been sent the link; webhook will flip the booking
  // to "paid" but a poll on this side gives the staff visible feedback
  // without requiring a refresh. Stops on success or after 10 min.
  const startPaymentPoll = () => {
    setPaymentLinkSent(true);
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
    }, 10000);
    setTimeout(() => clearInterval(pollInterval), 600000);
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
      const dateStr = new Date(b.booking_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "numeric" });
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

  // Which UI region (if any) should carry the pulsing next-action halo?
  // Computed once per render from the same logic the textual banner uses
  // so the two stay in sync. Exactly one region lights up at a time.
  const nextActionTarget = computeNextActionTarget(booking, existingPayments, compRequest);

  // Pending contract-holder pooled-usage charge, if any (Model B — posted
  // at checkout from actual check-in/check-out time, no longer a separate
  // "overtime" charge type) — derived from the already-fetched
  // bookingCharges list so it's correct on first load and survives a hard
  // reload, not just right after checkout.
  const pendingOvertimeUsageCharge = bookingCharges.find(
    (c) => c.booking_charge_kind === "pooled_usage" && c.status === "pending"
  ) ?? null;

  // Pricing is locked once any of the following is true — changing the
  // rate after a customer has paid creates a silent mismatch between the
  // receipt they were given and the booking record (and breaks the
  // monthly statement reconciliation). The server enforces the same
  // rules; this is just the UI mirror so the pencil doesn't tease.
  const hasVerifiedPayment = existingPayments.some((p) => p.status === "verified");
  const isTerminalStatus = ["cancelled", "checked_out", "no_show", "closed"].includes(booking.status);
  const isPaid = booking.payment_status === "paid";
  const canEditPricing = !isTerminalStatus && !isPaid && !hasVerifiedPayment;
  const lockReason = isTerminalStatus
    ? `Locked — booking is ${booking.status}`
    : isPaid
      ? "Locked — payment already collected"
      : hasVerifiedPayment
        ? "Locked — verified payment exists"
        : "";

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

        {/* Actions — wrapped in NextActionTarget so the row pulses
            when the next step lives here (e.g., Check In, Wrap Up). */}
        <NextActionTarget id="actions" currentTarget={nextActionTarget}>
        <div className="flex flex-wrap gap-2 p-1">
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
              {/* Cancel — opens the rich CancelBookingDialog instead of
                  the legacy confirm() prompt. The dialog handles the
                  reason picklist, optional caution, and the refund-vs-
                  retain branch in one structured ritual. */}
              <Button variant="destructive" size="sm" onClick={() => setCancelDialogOpen(true)} disabled={actionLoading}>
                <XCircle className="mr-1 h-4 w-4" />Cancel
              </Button>
              {/* Mark Complimentary — post-hoc "this should be free"
                  action. Only useful before payment is collected; the
                  dialog shows a clear explanation when the booking is
                  already paid (forces refund flow first). Hidden when
                  the booking is already waived. */}
              {booking.payment_status !== "waived" &&
               (userRole === "admin" || userRole === "manager" || userRole === "floor_manager") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMarkCompDialogOpen(true)}
                  className={
                    userRole === "floor_manager"
                      ? "border-blue-300 text-blue-700 hover:bg-blue-50"
                      : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  }
                  title={
                    userRole === "floor_manager"
                      ? "Request complimentary approval from a manager"
                      : "Mark this booking as complimentary (zero out the total + capture reason)"
                  }
                >
                  <Gift className="mr-1 h-4 w-4" />
                  {userRole === "floor_manager" ? "Request Comp" : "Comp"}
                </Button>
              )}
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
              {/* Defer remaining time — partial-checkout carry-forward.
                  Floor manager+ only (server enforces); we still show the
                  button to all staff so juniors can flag the request,
                  and the API gate fires on submit. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeferDialogOpen(true)}
                className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                title="Customer leaving early — issue a credit for unused hours"
              >
                <Coins className="mr-1 h-4 w-4" />Defer
              </Button>
            </>
          )}
          {/* Single "Collect Payment" entry — pops a chooser asking
              "At counter" or "Send link", then opens the relevant
              dialog. Replaces the prior trio (walk-in counter button +
              Send Payment Link + Copy Payment Link) with one button.
              Visible whenever payment is due regardless of customer
              type — contract holders can also collect at counter or
              via link if they choose to. */}
          {booking.payment_status !== "paid"
            && booking.payment_status !== "waived"
            && booking.payment_status !== "prepaid"
            && booking.payment_status !== "posted_to_bill" && (
            <NextActionTarget id="collect_payment" currentTarget={nextActionTarget}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setGetPaymentChooserOpen(true)}
              >
                <IndianRupee className="mr-1 h-4 w-4" />Collect Payment
              </Button>
            </NextActionTarget>
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
          {/* Reminders — opt-in checklist of post-checkout housekeeping
              (rate the customer, send feedback link). Doesn't change
              booking state; just nudges juniors who haven't built the
              habit yet. Hidden once the booking has both a rating and
              customer feedback so it doesn't pester veterans. */}
          {booking.status === "checked_out" && (!booking.feedback || !booking.customer_feedback) && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 text-emerald-700 hover:bg-emerald-50"
              onClick={() => setChecklistOpen(true)}
            >
              <CheckCircle className="mr-1 h-3.5 w-3.5" />Reminders
            </Button>
          )}
          {/* Add Charge (post-facto) — for charges discovered after the
              session ended (damage, missed F&B, late checkout fees).
              Routes to usage_charges, not this booking's total: for
              contract holders it lands on the next monthly invoice;
              for walk-ins / guests it becomes an outstanding charge to
              settle on their next visit. The label intentionally
              mirrors the in-session "Add charge" so staff see one
              consistent verb across the whole booking lifecycle —
              the underlying ledger differs but the intent is the same. */}
          {(booking.status === "checked_out" || booking.status === "no_show") && (
            <Button variant="outline" size="sm" onClick={() => setLogChargeOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />Add Charge
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
          <Button variant="outline" size="sm" onClick={handleCopyBookingDetails}>
            <Share2 className="mr-1 h-4 w-4" />Copy Details
          </Button>
          {actionLoading && <Loader2 className="h-4 w-4 animate-spin self-center" />}
        </div>
        </NextActionTarget>
      </div>

      {/* Suggested next action — guided hint derived from booking state.
          Shows a junior staff member what to do next so they don't have
          to memorise the state machine. Veterans can ignore it; the
          action buttons remain. */}
      <NextActionBanner booking={booking} existingPayments={existingPayments} compRequest={compRequest} />

      {/* Persistent overtime notice for contract holders — replaces the old
          15-second toast that offered nothing collectible (contract-holder
          bookings are always ₹0). Sourced from a real usage_charges row, so
          it's visible on reload until an admin/manager waives it or it's
          billed on the next statement. */}
      <OvertimeChargeBanner
        bookingId={booking.id}
        overtimeCharge={pendingOvertimeUsageCharge}
        userRole={userRole}
        onWaived={fetchBooking}
      />

      {/* Customer History — surfaced near the top so staff can calibrate
          the conversation immediately ("regular customer · 12 visits ·
          ₹X lifetime · clean payment record" vs "first-timer"). Used to
          live further down the page where it was easy to miss. */}
      {(booking.booker_phone || booking.lead?.phone || booking.guest_phone) && (
        <CustomerHistoryCard
          phone={booking.booker_phone || booking.lead?.phone || booking.guest_phone || ""}
          leadId={booking.lead?.id}
        />
      )}

      {/* Payment status summary — replaces the bare "posted_to_bill" pill
          with a finance-friendly banner that names the contract, the
          target invoice month, the method (when paid), free-quota math
          (when applicable), or the prepaid pack source. */}
      <BookingPaymentSummary
        booking={booking}
        variant="full"
        payments={existingPayments}
        onViewScreenshot={handleViewPaymentScreenshot}
        loadingScreenshotId={loadingScreenshotId}
      />

      {/* Outstanding charges from previous bookings */}
      {outstandingCharges.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="font-semibold text-amber-800">
                  Outstanding charges from previous visits — {formatCurrency(outstandingTotal)}
                </p>
                <p className="text-sm text-amber-700 mb-2">
                  {customerName} has {outstandingCharges.length} unpaid charge{outstandingCharges.length > 1 ? "s" : ""} logged against past bookings.
                </p>
              </div>
              {/* Bulk import — adds every outstanding charge as addons on
                  this booking and clears them from the queue at once.
                  Hidden if booking is locked (paid / terminal). */}
              {canEditPricing && outstandingCharges.length > 1 && (
                <Button
                  size="sm"
                  className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white shrink-0"
                  onClick={async () => {
                    if (!confirm(`Add all ${outstandingCharges.length} outstanding charges as add-ons to this booking? Customer's total will increase by ${formatCurrency(outstandingTotal)}.`)) return;
                    const res = await fetch(`/api/bookings/${id}/import-old-dues`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ charge_ids: outstandingCharges.map((c) => c.id) }),
                    });
                    const json = await res.json();
                    if (res.ok) {
                      toast.success(`${json.imported} charge${json.imported > 1 ? "s" : ""} imported as add-ons`);
                      setOutstandingCharges([]);
                      fetchBooking();
                    } else {
                      toast.error(json.error || "Failed to import");
                    }
                  }}
                >
                  Add all to this bill
                </Button>
              )}
            </div>
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
                      {/* Add to bill — imports this charge as an addon
                          on the current booking. Replaces the legacy
                          "Collect" path which marked the charge as
                          billed but didn't roll into the booking total
                          (so customers were undercharged). */}
                      {canEditPricing && (
                        <button
                          type="button"
                          className="text-xs text-green-700 hover:text-green-900 underline font-medium"
                          title="Add this charge as an add-on to the current booking"
                          onClick={async () => {
                            const res = await fetch(`/api/bookings/${id}/import-old-dues`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ charge_ids: [c.id] }),
                            });
                            if (res.ok) {
                              toast.success("Added as add-on — customer total updated");
                              setOutstandingCharges((prev) => prev.filter((ch) => ch.id !== c.id));
                              fetchBooking();
                            } else {
                              const err = await res.json().catch(() => null);
                              toast.error(err?.error || "Failed to add to bill");
                            }
                          }}
                        >
                          Add to bill
                        </button>
                      )}
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

      {/* Payment Collected Banner — derived from ACTUAL verified
          payments, not the booking.payment_status flag (which can go
          stale when a booking is edited after partial payment). Two
          modes:
            - Fully paid → green "Payment Collected Successfully" with
              the actual collected total
            - Underpaid (flag says paid but actual collected < total)
              → amber warning showing "X of Y collected · ₹Z still due"
              so finance sees the truth, not a misleading green tick. */}
      {booking.payment_status === "paid" && (() => {
        const razorpayPayment = existingPayments.find(p => p.payment_mode === "razorpay" && p.status === "verified");
        const actualPaid = existingPayments
          .filter((p) => p.status === "verified")
          .reduce((s, p) => s + Number(p.amount), 0);
        const grandTotal = Number(booking.total_amount_with_gst) || Number(booking.total_amount);
        const isFullyPaid = actualPaid + 0.01 >= grandTotal;
        const balanceDue = Math.max(0, grandTotal - actualPaid);
        const tone = isFullyPaid
          ? { bg: "bg-green-50", border: "border-green-200", icon: "text-green-600", iconBg: "bg-green-100", title: "text-green-800", body: "text-green-600" }
          : { bg: "bg-amber-50",  border: "border-amber-200",  icon: "text-amber-700",  iconBg: "bg-amber-100",  title: "text-amber-800",  body: "text-amber-700" };
        return (
          <div className={`${tone.bg} border ${tone.border} rounded-lg p-4 flex items-start gap-3`}>
            <div className={`flex-shrink-0 w-12 h-12 ${tone.iconBg} rounded-full flex items-center justify-center`}>
              {isFullyPaid
                ? <CheckCircle className={`h-7 w-7 ${tone.icon}`} />
                : <AlertTriangle className={`h-7 w-7 ${tone.icon}`} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className={`font-semibold ${tone.title}`}>
                {isFullyPaid ? "Payment Collected Successfully" : "Partial Payment — balance still due"}
              </p>
              <p className={`text-sm ${tone.body}`}>
                {isFullyPaid
                  ? <>
                      {formatCurrency(actualPaid)} paid via {(booking.payment_mode && PAYMENT_MODE_LABELS[booking.payment_mode]) || booking.payment_mode || "online payment"}
                      {booking.status === "confirmed" && " — Ready for check-in"}
                    </>
                  : <>
                      {formatCurrency(actualPaid)} collected of {formatCurrency(grandTotal)} —
                      <strong> {formatCurrency(balanceDue)} still due.</strong>{" "}
                      The booking total likely changed after the original payment was taken.
                    </>}
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
        {/* Send/Copy Payment Link buttons removed in favor of the
            unified "Collect Payment" chooser above. The payment-link
            flow itself is preserved — it's just one click deeper now,
            chosen via the chooser dialog. */}
        {paymentLinkSent && (
          <Badge variant="outline" className="text-[10px] border-blue-300 text-blue-700 bg-blue-50 animate-pulse">
            ⏳ Awaiting payment…
          </Badge>
        )}
      </div>

      {/* Booking Lifecycle Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Booking Lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <BookingLifecycleTimeline booking={booking} compRequest={compRequest} />
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
              <span className="text-muted-foreground">
                {booking.pricing_model === "daily" ? "Access window" : "Time"}
              </span>
              <span>{formatTime12(booking.start_time)} – {formatTime12(booking.end_time)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Duration</span>
              {/* Day-pass bookings: show "Day Pass (full day)" instead
                  of the misleading "1 hour" — the duration_hours=1 is
                  a legacy marker, the real meaning is "full day during
                  the access window above". Hourly bookings render the
                  actual hours+minutes. */}
              <span>
                {booking.pricing_model === "daily"
                  ? "Day Pass (full day)"
                  : formatDuration(Number(booking.duration_hours))}
              </span>
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
            {booking.lead_id && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">KYC</span>
                {booking.lead?.id_proof_path ? (
                  <a
                    href={`/api/leads/${booking.lead_id}/id-proof`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
                    title="Open the customer's KYC identity document"
                  >
                    <FileText className="h-3 w-3" />
                    View KYC
                  </a>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-dashed text-muted-foreground cursor-default"
                    title="No KYC document uploaded for this customer"
                  >
                    <FileText className="h-3 w-3" />
                    No KYC
                  </span>
                )}
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

        {/* Access PIN (COSEC) — shown for active bookings regardless of whether PIN is provisioned yet */}
        {(booking.status === "confirmed" || booking.status === "checked_in") && (() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const existingPin = (booking as any).access_pin as string | null;

          async function provisionPin() {
            const res = await fetch("/api/cosec/booking-access", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ booking_id: id }),
            });
            const json = res.ok ? await res.json() : null;
            if (res.ok && json) {
              // Surface per-channel delivery result
              if (json.delivery) setPinDelivery(json.delivery);
              // Refresh booking to pick up new access_pin value
              const bRes = await fetch(`/api/bookings/${id}`);
              if (bRes.ok) { const j = await bRes.json(); setBooking(j.data); }
              // Refresh provisioned device list
              fetch(`/api/cosec/booking-devices?booking_id=${id}`)
                .then(r => r.json()).then(j => setBookingDevices(j.data || [])).catch(() => {});
            }
            return res.ok;
          }

          // Build the shareable PIN message the staff member can copy and send manually
          function buildShareMessage(pin: string) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const b = booking!;
            const startStr = formatTime12(b.start_time);
            const endStr   = formatTime12(b.end_time);
            const dateStr  = formatDate(b.booking_date);
            return `Hi, your door access PIN for The WorkVilla is: *${pin}*\n\nBooking: ${b.booking_number}\nDate: ${dateStr}\nTime: ${startStr} – ${endStr}\n\nEnter this PIN at the entrance device to unlock the door. PIN expires 5 minutes after your booking ends.\n– The WorkVilla`;
          }

          function DeliveryBadge({ label, status }: { label: string; status: string }) {
            if (status === "sent")     return <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-green-50 border border-green-200 text-green-700"><Check size={10} />{label}</span>;
            if (status === "failed")   return <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-600"><X size={10} />{label} failed</span>;
            if (status === "disabled") return <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700">{label} off</span>;
            return null; // skipped — no badge
          }

          return (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <KeyRound size={14} />Access PIN
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {existingPin ? (
                  <>
                    {/* PIN display row */}
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-3xl font-mono font-bold tracking-widest">{existingPin}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Valid {formatTime12(booking.start_time)} – {formatTime12(booking.end_time)} (±5 min)</p>
                      </div>
                      <div className="flex flex-col gap-1.5 items-end">
                        <Button
                          variant="outline" size="sm"
                          onClick={async () => {
                            setPinDelivery(null);
                            const ok = await provisionPin();
                            if (ok) toast.success("Access PIN resent");
                            else toast.error("Failed to resend PIN");
                          }}
                        >
                          <Send size={13} className="mr-1.5" />Resend PIN
                        </Button>
                        {/* Copy to share */}
                        <Button
                          variant="ghost" size="sm"
                          className="text-muted-foreground h-7 text-xs"
                          onClick={() => {
                            navigator.clipboard.writeText(buildShareMessage(existingPin)).then(() => {
                              setPinCopied(true);
                              setTimeout(() => setPinCopied(false), 2500);
                            });
                          }}
                        >
                          {pinCopied ? <Check size={12} className="mr-1.5 text-green-600" /> : <Copy size={12} className="mr-1.5" />}
                          {pinCopied ? "Copied!" : "Copy to share"}
                        </Button>
                      </div>
                    </div>

                    {/* Delivery status — shown after Resend or Generate */}
                    {pinDelivery && (
                      <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                        <span className="text-[11px] text-muted-foreground mr-0.5">Sent via:</span>
                        <DeliveryBadge label="WhatsApp" status={pinDelivery.whatsapp} />
                        <DeliveryBadge label="SMS" status={pinDelivery.sms} />
                        <DeliveryBadge label="Email" status={pinDelivery.email} />
                        {pinDelivery.at && (
                          <span className="text-[10px] text-muted-foreground ml-0.5">
                            {formatDateTime(pinDelivery.at)}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">No PIN provisioned yet for this booking.</p>
                    <Button
                      size="sm"
                      onClick={async () => {
                        setPinDelivery(null);
                        const ok = await provisionPin();
                        if (ok) toast.success("Access PIN generated and sent");
                        else toast.error("Failed to generate PIN — check COSEC device config");
                      }}
                    >
                      <KeyRound size={13} className="mr-1.5" />Generate &amp; Send PIN
                    </Button>
                  </div>
                )}

                {/* Active access points */}
                {bookingDevices.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Access points activated</p>
                    <div className="flex flex-wrap gap-2">
                      {bookingDevices.map((bd) => {
                        const isRoom = bd.device?.device_category === "business_centre";
                        return (
                          <div key={bd.id} className={`flex items-center gap-1.5 text-xs rounded px-2 py-1 ${
                            isRoom
                              ? "bg-violet-50 border border-violet-200 text-violet-700"
                              : "bg-green-50 border border-green-200 text-green-700"
                          }`}>
                            {isRoom ? <Building2 size={11} /> : <DoorOpen size={11} />}
                            <span>{bd.device?.label ?? "Device"}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })()}

        {/* Access Log — entry/exit events from COSEC devices for this booking */}
        {(booking.status === "confirmed" || booking.status === "checked_in" || booking.status === "checked_out") && (() => {
          function fmtEventTime(iso: string) {
            const d = new Date(iso);
            return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
          }

          function DirectionBadge({ direction }: { direction: string }) {
            if (direction === "IN") return (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-700">
                <LogIn size={10} />Entry
              </span>
            );
            if (direction === "OUT") return (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
                <LogOut size={10} />Exit
              </span>
            );
            return (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-600">
                <ShieldAlert size={10} />Denied
              </span>
            );
          }

          return (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity size={14} />Entry Activity
                  {accessLogs.length > 0 && (
                    <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                      {accessLogs.filter(l => l.direction === "IN").length} entries · {accessLogs.filter(l => l.direction === "OUT").length} exits
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {accessLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-1">
                    No swipes recorded yet. Events appear once the guest uses the PIN at a COSEC device.
                  </p>
                ) : (
                  <ol className="relative border-l border-border ml-2 space-y-0">
                    {accessLogs.map((log, i) => {
                      const isFirst = i === 0;
                      const isLast = i === accessLogs.length - 1;
                      return (
                        <li key={log.id} className={`pl-4 ${isFirst ? "pb-3" : isLast ? "pt-3" : "py-3"}`}>
                          {/* Timeline dot */}
                          <span className={`absolute -left-[5px] mt-0.5 h-2.5 w-2.5 rounded-full border-2 border-background ${
                            log.direction === "IN"     ? "bg-green-500" :
                            log.direction === "OUT"    ? "bg-amber-400" :
                                                        "bg-red-400"
                          }`} />
                          <div className="flex items-center gap-2 flex-wrap">
                            <DirectionBadge direction={log.direction} />
                            <span className="text-xs text-muted-foreground font-mono">{fmtEventTime(log.event_time)}</span>
                            {log.device && (
                              <span className="text-xs text-muted-foreground">
                                via{log.device.device_code && (
                                  <span className="font-mono ml-1 text-slate-500">{log.device.device_code}</span>
                                )}{" "}
                                <span className="text-foreground">{log.device.label}</span>
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </CardContent>
            </Card>
          );
        })()}

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
                  {canEditPricing ? (
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
                  ) : (
                    <span
                      className="text-[10px] text-muted-foreground/70 ml-1.5 px-1.5 py-0.5 rounded bg-muted/50"
                      title={lockReason}
                    >
                      🔒
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Room subtotal / GST / total are only rendered while editing —
                they exist to preview the recalculation before saving. The
                Transaction Summary above is the canonical breakdown, so
                showing a static copy here just gave staff two numbers to
                reconcile. */}

            {/* Subtotal (ex-GST) — editable so staff can apply a custom
                discount that the rate × duration formula doesn't capture
                (e.g. goodwill credit, partial waiver). GST and grand
                total update live from this field. */}
            {editingPricing && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Subtotal (ex-GST)</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draftTotal}
                  onChange={(e) => setDraftTotal(e.target.value)}
                  className="h-7 w-28 text-right text-sm"
                  disabled={pricingSaving}
                />
              </div>
            )}

            {/* GST breakdown — recalculated live from draftTotal during edit
                so the user sees the new GST and grand total before saving.
                Static otherwise. */}
            {editingPricing && booking.gst_rate ? (
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>GST ({booking.gst_rate}%)</span>
                <span>
                  {formatCurrency(((parseFloat(draftTotal) || 0) * Number(booking.gst_rate)) / 100)}
                </span>
              </div>
            ) : null}

            {/* Total Amount — live grand total during edit (subtotal +
                freshly computed GST). Server recomputes the same way on
                save, so what you see is what gets stored. */}
            {editingPricing && (
              <div className="flex justify-between items-center font-medium">
                <span className="text-muted-foreground">Total (incl. GST)</span>
                <span>
                  {formatCurrency(
                    (parseFloat(draftTotal) || 0) *
                      (1 + Number(booking.gst_rate || 0) / 100)
                  )}
                </span>
              </div>
            )}

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
                      {/* Cash trail — who collected and where the money is
                          right now. Only meaningful for cash payments;
                          surfaces the audit trail finance asks for
                          ("who has the cash in hand?"). */}
                      {p.payment_mode === "cash" && (
                        <div className="mt-1.5 pt-1.5 border-t border-muted/50 text-[11px] space-y-0.5">
                          {p.collector?.full_name && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Collected by</span>
                              <span className="font-medium">{p.collector.full_name}</span>
                            </div>
                          )}
                          {p.cash_handover_status === "pending_handover" && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Handover</span>
                              <span className="text-amber-700 font-medium">
                                Pending — cash with {p.collector?.full_name || "collector"}
                              </span>
                            </div>
                          )}
                          {p.cash_handover_status === "handed_over" && (
                            <>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Handed over to</span>
                                <span className="font-medium">{p.handover_receiver?.full_name || "—"}</span>
                              </div>
                              {p.handover_confirmer?.full_name && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Confirmed by</span>
                                  <span className="font-medium text-emerald-700">{p.handover_confirmer.full_name}</span>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {p.payment_mode === "upi" && p.screenshot_path && (
                        <div className="mt-1.5 pt-1.5 border-t border-muted/50">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline underline-offset-2"
                            onClick={() => handleViewPaymentScreenshot(p.id, p.screenshot_path!)}
                            disabled={loadingScreenshotId === p.id}
                          >
                            {loadingScreenshotId === p.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <ImageIcon className="h-3 w-3" />
                            )}
                            View payment screenshot
                          </button>
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
          clicks "Add charge" (or automatically on checkout overtime).
          canEdit reuses canEditPricing so add-on add/remove is locked under
          the same rules as the rate edit (paid / verified payment / terminal
          status). The server enforces the same — this just hides the UI. */}
      {booking.space_id && (
        showAddonsSection ? (
          <BookingAddonsSection
            bookingId={booking.id}
            spaceId={booking.space_id}
            canEdit={canEditPricing}
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
            {/* Same lock as the in-section "Add charge" — once payment is
                collected, charges can't be added (would create a hidden
                balance due). */}
            {canEditPricing ? (
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
            ) : (
              <span
                className="text-[10px] text-muted-foreground/70 px-2 py-1 rounded bg-muted/50"
                title={lockReason}
              >
                🔒 {lockReason}
              </span>
            )}
          </div>
        )
      )}

      {/* Related Charges — always visible for checked-out / no-show bookings.
          Shows post-checkout charges (damage, overtime, missed F&B) with an
          "Add Charge" button so staff don't have to find it in the header.
          For contract holders charges flow into the next billing statement;
          for walk-ins / guests they become outstanding on the lead profile. */}
      {/* Transaction Summary — the single money view for this booking.
          Replaces the old "Related Charges" card and the Financials card's
          static total block, so the room charge, over-use, overtime, waivers
          and add-ons all reconcile to one grand total instead of being
          spread across four places that each showed a different number. */}
      <div className="space-y-2">
        <TransactionSummary
          booking={booking}
          charges={bookingCharges}
          addons={bookingAddons}
          payments={existingPayments}
        />
        {["checked_out", "no_show"].includes(booking.status) && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setLogChargeOpen(true)}>
              <Plus className="mr-1 h-3 w-3" />Add Charge
            </Button>
          </div>
        )}
      </div>

      {/* Customer History — moved to the top of the page (rendered just
          after the header and next-action banner). This block is left
          here to preserve the original layout placeholder; the actual
          render is up there now. */}

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
        onSuccess={handlePaymentRecorded}
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

      <DeferBookingDialog
        open={deferDialogOpen}
        onOpenChange={setDeferDialogOpen}
        bookingId={booking.id}
        bookingNumber={booking.booking_number || ""}
        bookedHours={Number(booking.duration_hours || 0)}
        hourlyRate={Number(booking.hourly_rate || 0)}
        checkInAt={booking.check_in_at || null}
        customerPhone={booking.booker_phone || booking.guest_phone || booking.lead?.phone || ""}
        locationName={booking.location?.name || ""}
        onSuccess={fetchBooking}
      />

      <SharePaymentLinkDialog
        open={paymentSendDialogOpen}
        onOpenChange={setPaymentSendDialogOpen}
        bookingId={booking.id}
        bookingNumber={booking.booking_number || ""}
        customerName={customerName}
        customerEmail={customerEmail || null}
        customerPhone={customerPhone || null}
        amount={Number(booking.total_amount_with_gst) || Number(booking.total_amount)}
        ensurePaymentLink={ensureRazorpayPaymentLink}
        internalLinkFallback={typeof window !== "undefined" && booking.payment_token ? `${window.location.origin}/pay/${booking.payment_token}` : ""}
        onSent={startPaymentPoll}
      />

      <PostCheckoutChecklistDialog
        open={checklistOpen}
        onOpenChange={setChecklistOpen}
        booking={booking}
        existingPayments={existingPayments}
        outstandingCount={outstandingCharges.length}
        onOpenRateCustomer={() => { setChecklistOpen(false); setFeedbackDialogOpen(true); }}
        onOpenSendFeedback={async () => {
          // Reuse the existing feedback-link email flow.
          setChecklistOpen(false);
          await handleSendFeedbackLink();
        }}
      />

      <GetPaymentChooser
        open={getPaymentChooserOpen}
        onOpenChange={setGetPaymentChooserOpen}
        amountDue={(() => {
          const grandTotal = Number(booking.total_amount_with_gst) || Number(booking.total_amount);
          const paid = existingPayments.filter((p) => p.status === "verified").reduce((s, p) => s + Number(p.amount), 0);
          return Math.max(0, grandTotal - paid);
        })()}
        onPickCounter={() => setPaymentDialogOpen(true)}
        onPickLink={() => setPaymentSendDialogOpen(true)}
      />

      <CancelBookingDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        booking={booking}
        existingPayments={existingPayments}
        onCancelled={fetchBooking}
      />

      <MarkComplimentaryDialog
        open={markCompDialogOpen}
        onOpenChange={setMarkCompDialogOpen}
        bookingId={booking.id}
        bookingNumber={booking.booking_number || ""}
        currentTotal={Number(booking.total_amount_with_gst) || Number(booking.total_amount) || 0}
        hasCollectedPayment={existingPayments.some((p) => p.status === "verified")}
        onSuccess={() => { fetchBooking(); fetchCompRequest(); }}
        userRole={userRole}
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

      {zoomedScreenshotUrl && (
        <div
          className="fixed inset-0 z-[200] bg-black/80 flex flex-col items-center justify-center p-6 cursor-pointer"
          onClick={() => setZoomedScreenshotUrl(null)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
            onClick={() => setZoomedScreenshotUrl(null)}
          >
            <X className="h-8 w-8" />
          </button>
          <div className="bg-white rounded-2xl p-3 shadow-2xl max-w-[90vw] max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={zoomedScreenshotUrl}
              alt="UPI payment confirmation screenshot"
              className="max-w-[85vw] max-h-[80vh] object-contain rounded"
            />
          </div>
          <p className="text-white/40 text-xs mt-3">Tap anywhere to close</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WiFi Voucher card — on-demand issuance with count selector + reveal.
//
// Vouchers are NOT auto-issued at booking creation. Staff decides how many
// to issue based on actual attendees (an 8-seat room with 2 people only
// needs 1 code, not 4). Each code is hidden behind a "Reveal" tap to
// prevent accidental exposure of unused codes.
// ---------------------------------------------------------------------------

interface VoucherIssuance {
  id?: string;
  is_active: boolean;
  voucher?: { voucher_code: string } | null;
  issued_at?: string | null;
  unifi_code?: string | null;
  unifi_voucher_id?: string | null;
  ruijie_code?: string | null;
  ruijie_voucher_uuid?: string | null;
  emailed_at?: string | null;
  duration_minutes?: number | null;
  seat_occupant_email?: string | null;
  revoked_at?: string | null;
  revoke_reason?: string | null;
}

// Renders a voucher's recorded validity window. Null for issuances created
// before duration_minutes existed — those genuinely have no recorded validity.
function formatVoucherValidity(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${h}h ${m}m`;
}

// Resolves an issuance's display code across the three backends —
// repository (joined voucher.voucher_code), UniFi (unifi_code), Ruijie
// (ruijie_code). Falls back to null when the code was never captured
// locally (e.g. controller-generated code not persisted).
function voucherCodeOf(v: VoucherIssuance): string | null {
  return v.voucher?.voucher_code ?? v.unifi_code ?? v.ruijie_code ?? null;
}

function WifiVoucherCard({
  booking,
  existingIssuances,
  onIssued,
}: {
  booking: Booking & { voucher_seat_cap?: number };
  existingIssuances: VoucherIssuance[];
  onIssued: () => void;
}) {
  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;
  const [requesting, setRequesting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  // An issuance counts as "issued" regardless of whether we captured its
  // code locally. Null codes only happen for issuances created before this
  // route started persisting unifi_code/ruijie_code at issue time — those
  // legacy rows are recoverable via the email endpoint's controller lookup.
  const activeIssuances = existingIssuances.filter((v) => v.is_active);
  // Revoked vouchers are kept visible as history (not filtered out) so staff
  // can tell a customer "yes, that code was issued and revoked" instead of
  // seeing no record at all. They never count toward the seat cap. Most
  // recent first, capped to avoid the card growing unbounded on long bookings.
  const REVOKED_HISTORY_LIMIT = 5;
  const revokedIssuances = existingIssuances
    .filter((v) => !v.is_active)
    .sort((a, b) => {
      const at = a.revoked_at ? new Date(a.revoked_at).getTime() : 0;
      const bt = b.revoked_at ? new Date(b.revoked_at).getTime() : 0;
      return bt - at;
    });
  const visibleRevoked = revokedIssuances.slice(0, REVOKED_HISTORY_LIMIT);
  const hiddenRevokedCount = revokedIssuances.length - visibleRevoked.length;
  // Where voucher codes go. Email is currently the only delivery channel —
  // MSG91 has no approved WhatsApp template for WiFi codes, so there is
  // deliberately no WhatsApp/SMS send to report here.
  const voucherRecipient =
    booking.guest_email || (booking as { lead?: { email?: string | null } }).lead?.email || null;

  const isActive = ["confirmed", "checked_in"].includes(booking.status);

  // Cap enforcement mirrors the server: a customer must never hold more
  // vouchers than the seats they booked. voucher_seat_cap is additive on
  // GET /api/bookings/{id}; when absent, treat as uncapped in the UI.
  const seatCap = booking.voucher_seat_cap ?? null;
  const atCap = seatCap != null && activeIssuances.length >= seatCap;

  const issueOne = async (overrideReason?: string) => {
    setRequesting(true);
    const body: { count: number; override_reason?: string } = { count: 1 };
    if (overrideReason) body.override_reason = overrideReason;
    const res = await fetch(`/api/bookings/${booking.id}/vouchers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok) {
      toast.success(
        `${json.issued} WiFi voucher${json.issued !== 1 ? "s" : ""} issued${json.emailed ? " and emailed to the customer" : ""}`
      );
      // Auto-email is best-effort so it never blocks issuance — but staff must know
      // when it didn't land, otherwise the code silently reaches nobody (the exact
      // failure this fix exists to prevent). Prompt the manual resend instead.
      if (json.emailed === false) {
        toast.warning("Voucher issued, but the email did not go out — use \u201cResend\u201d, or check the customer has an email address on file.");
      }
      if (json.shortfall > 0) {
        toast.warning(`${json.shortfall} voucher${json.shortfall !== 1 ? "s" : ""} could not be issued — stock is low.`);
      }
      onIssued();
    } else if (res.status === 422) {
      toast.error(json.error || `Seat cap reached — ${json.already_issued ?? activeIssuances.length} of ${json.seat_cap ?? seatCap} already issued.`);
    } else if (res.status === 403) {
      toast.error(json.error || "Only an admin can override the seat cap.");
    } else {
      toast.error(json.error || "Failed to issue voucher");
    }
    setRequesting(false);
  };

  const handleIssueNew = async () => {
    if (atCap) {
      // Non-admins never see this affordance enabled — the button is
      // disabled at the cap for them. Admins get an explicit, logged
      // override path instead of a silent bypass.
      if (userRole !== "admin") return;
      const reason = window.prompt(
        `All ${seatCap} seat${seatCap === 1 ? "" : "s"}' vouchers are already issued. Enter a reason to override the seat cap and issue one more:`
      );
      if (!reason || !reason.trim()) return;
      await issueOne(reason.trim());
      return;
    }
    await issueOne();
  };

  const handleEmailVouchers = async () => {
    setEmailing(true);
    const res = await fetch(`/api/bookings/${booking.id}/vouchers/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    if (res.ok) {
      toast.success(json.message || "Voucher emailed");
      onIssued();
    } else {
      toast.error(json.error || "Failed to email vouchers");
    }
    setEmailing(false);
  };

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code).then(
      () => toast.success("Code copied"),
      () => toast.error("Copy failed"),
    );
  };

  const handleRevoke = async (issuanceId: string) => {
    const confirmed = window.confirm(
      "Revoke this voucher? The customer's internet access on this code stops immediately."
    );
    if (!confirmed) return;
    setRevokingId(issuanceId);
    const res = await fetch(`/api/bookings/${booking.id}/vouchers/${issuanceId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(json.message || "Voucher revoked");
      onIssued();
    } else {
      // Ruijie locations return 501 (revocation not supported there yet) —
      // and 409 for an already-revoked code, 502 on controller failure.
      // Surface the server's message as-is rather than a generic failure.
      toast.error(json.error || "Failed to revoke voucher");
    }
    setRevokingId(null);
  };

  const handleReplace = async (issuanceId: string) => {
    const confirmed = window.confirm(
      "Revoke & reissue this voucher? The current code stops working immediately and a new code will be emailed to the customer."
    );
    if (!confirmed) return;
    setReplacingId(issuanceId);
    const res = await fetch(`/api/bookings/${booking.id}/vouchers/${issuanceId}/replace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(
        json.emailed
          ? "Voucher revoked — a new code was emailed to the customer"
          : "Voucher revoked and reissued, but the email did not go out — use “Resend”."
      );
      onIssued();
    } else {
      // Ruijie returns 501 (not supported there yet), 409 if already revoked,
      // 502 on controller failure — surface the server's message as-is.
      toast.error(json.error || "Failed to revoke & reissue voucher");
    }
    setReplacingId(null);
  };

  const issueNewButton = (fullWidth: boolean) => (
    <Button
      size="sm"
      variant={fullWidth ? "default" : "outline"}
      className={fullWidth ? "flex-1" : "text-xs h-7 flex-1"}
      onClick={handleIssueNew}
      disabled={requesting || (atCap && userRole !== "admin")}
      title={
        atCap
          ? userRole === "admin"
            ? `All ${seatCap} seat${seatCap === 1 ? "’s" : "s’"} vouchers issued — override with a reason, or revoke one to issue another.`
            : `All ${seatCap} seat${seatCap === 1 ? "’s" : "s’"} vouchers issued — revoke one to issue another.`
          : undefined
      }
    >
      {requesting
        ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Issuing…</>
        : <><Wifi className="h-3.5 w-3.5 mr-1" />Issue New</>}
    </Button>
  );

  // Helper: renders a revoked issuance row (muted, struck-through code, no
  // Revoke/Resend affordances — this is history, not a live code).
  const renderRevokedRow = (v: VoucherIssuance, idx: number) => {
    const vid = v.id || `revoked-${idx}`;
    const isRevealed = revealedIds.has(vid);
    const code = voucherCodeOf(v);
    return (
      <div key={vid} className="flex items-center justify-between rounded-md bg-muted/20 px-3 py-2 opacity-70">
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground">
            Revoked {v.revoked_at ? formatDateTime(v.revoked_at) : "—"}
            {v.revoke_reason ? ` · ${v.revoke_reason}` : ""}
          </span>
          {v.emailed_at && (
            <span
              className="text-[10px] text-muted-foreground flex items-center gap-0.5"
              title={`Was emailed${v.seat_occupant_email || voucherRecipient ? ` to ${v.seat_occupant_email || voucherRecipient}` : ""} on ${formatDateTime(v.emailed_at)}. This code no longer works.`}
            >
              <Mail className="h-2.5 w-2.5" />
              Was emailed{v.seat_occupant_email || voucherRecipient ? ` to ${v.seat_occupant_email || voucherRecipient}` : ""} · {formatDateTime(v.emailed_at)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {code === null ? (
            <span className="text-xs text-muted-foreground italic">Code not recorded</span>
          ) : isRevealed ? (
            <span className="font-mono text-sm text-muted-foreground line-through tracking-wider">
              {code}
            </span>
          ) : (
            <button
              onClick={() => toggleReveal(vid)}
              className="text-xs text-muted-foreground hover:underline"
            >
              Tap to reveal
            </button>
          )}
        </div>
      </div>
    );
  };

  const revokedHistorySection = revokedIssuances.length > 0 && (
    <div className="space-y-1.5 pt-1">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Previously issued</p>
      <div className="space-y-1.5">
        {visibleRevoked.map((v, idx) => renderRevokedRow(v, idx))}
      </div>
      {hiddenRevokedCount > 0 && (
        <p className="text-[10px] text-muted-foreground">
          + {hiddenRevokedCount} more revoked voucher{hiddenRevokedCount === 1 ? "" : "s"} not shown
        </p>
      )}
    </div>
  );

  // No vouchers issued yet at all (neither active nor revoked) — show a
  // single issue action. If any revoked ones exist, fall through to the
  // full card so that history is visible instead of the empty state.
  if (activeIssuances.length === 0 && revokedIssuances.length === 0) {
    if (!isActive) return null;
    return (
      <Card className="border-dashed">
        <CardContent className="py-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wifi className="h-4 w-4" />
            <span>No WiFi vouchers issued yet</span>
            {seatCap != null && (
              <span className="ml-auto text-xs tabular-nums">0 of {seatCap} seat{seatCap === 1 ? "" : "s"} used</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {issueNewButton(true)}
          </div>
          {atCap && (
            <p className="text-[10px] text-muted-foreground">
              All {seatCap} seat{seatCap === 1 ? "’s" : "s’"} vouchers issued — revoke one to issue another.
              {userRole === "admin" ? " Admins can override with a reason." : ""}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (activeIssuances.length === 0) {
    // All issued vouchers have been revoked — show history-only card, no
    // active-row rendering, but still allow issuing a fresh one if active.
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wifi className="h-4 w-4" />
            WiFi Vouchers
            <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
              {seatCap != null ? `0 of ${seatCap} seat${seatCap === 1 ? "" : "s"} used` : "0 active"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {revokedHistorySection}
          {isActive && (
            <div className="flex items-center gap-2 pt-1 border-t">
              {issueNewButton(true)}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Vouchers have been issued — show with reveal-on-click
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          WiFi Vouchers
          <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
            {seatCap != null
              ? `${activeIssuances.length} of ${seatCap} seat${seatCap === 1 ? "" : "s"} used`
              : `${activeIssuances.length} issued`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="space-y-1.5">
          {activeIssuances.map((v, idx) => {
            const vid = v.id || String(idx);
            const isRevealed = revealedIds.has(vid);
            const code = voucherCodeOf(v);
            const issuedAtLabel = v.issued_at ? formatDateTime(v.issued_at) : null;
            const validityLabel = formatVoucherValidity(v.duration_minutes);
            return (
              <div key={vid} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">#{idx + 1}</span>
                  {issuedAtLabel && (
                    <span className="text-[10px] text-muted-foreground">Issued {issuedAtLabel}</span>
                  )}
                  {validityLabel ? (
                    <span className="text-[10px] text-muted-foreground">Valid for {validityLabel}</span>
                  ) : (
                    <span
                      className="text-[10px] text-muted-foreground italic"
                      title="Validity was not recorded for vouchers issued before this was tracked"
                    >
                      Validity not recorded
                    </span>
                  )}
                  {v.emailed_at ? (
                    <span
                      className="text-[10px] text-green-700 flex items-center gap-0.5"
                      title={`Sent by email${v.seat_occupant_email || voucherRecipient ? ` to ${v.seat_occupant_email || voucherRecipient}` : ""} on ${formatDateTime(v.emailed_at)}. Email is the only delivery channel for WiFi codes.`}
                    >
                      <Mail className="h-2.5 w-2.5" />
                      Emailed{v.seat_occupant_email || voucherRecipient ? ` to ${v.seat_occupant_email || voucherRecipient}` : ""} · {formatDateTime(v.emailed_at)}
                    </span>
                  ) : (
                    <span
                      className="text-[10px] text-amber-700 flex items-center gap-0.5"
                      title="This code has not been sent to the customer yet. Use \u201cResend\u201d below."
                    >
                      <Mail className="h-2.5 w-2.5" />Not sent to customer yet
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {code === null ? (
                    <span
                      className="text-xs text-muted-foreground italic"
                      title="Voucher was generated on the WiFi controller but its code was not stored locally"
                    >
                      Code not recorded
                    </span>
                  ) : isRevealed ? (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold tracking-wider">
                        {code}
                      </span>
                      <button
                        onClick={() => copyCode(code)}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title="Copy code"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => toggleReveal(vid)}
                      className="text-xs text-primary hover:underline font-medium"
                    >
                      Tap to reveal
                    </button>
                  )}
                  {v.id && (
                    <button
                      onClick={() => handleReplace(v.id!)}
                      disabled={replacingId === v.id || revokingId === v.id}
                      className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 shrink-0"
                      title="Revoke & reissue — the current code stops working immediately and a new code is emailed to the customer"
                    >
                      {replacingId === v.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RotateCw className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  {v.id && (
                    <button
                      onClick={() => handleRevoke(v.id!)}
                      disabled={revokingId === v.id || replacingId === v.id}
                      className="text-destructive hover:text-destructive/80 transition-colors disabled:opacity-50 shrink-0"
                      title="Revoke this voucher — internet access stops immediately"
                    >
                      {revokingId === v.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <X className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground text-center">
          Each code supports 2 device logins · tap to reveal when needed
        </p>

        {revokedHistorySection}

        <Button
          size="sm"
          variant="secondary"
          className="w-full text-xs h-7"
          onClick={handleEmailVouchers}
          disabled={emailing}
        >
          {emailing
            ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Emailing…</>
            : <><Mail className="h-3 w-3 mr-1" />{voucherRecipient ? `Resend to ${voucherRecipient}` : "Resend to customer"}</>}
        </Button>

        {/* Issue new — only for active bookings, hard-capped at seats booked */}
        {isActive && (
          <div className="flex flex-col gap-1 pt-1 border-t">
            <div className="flex items-center gap-2 pt-1">
              {issueNewButton(false)}
            </div>
            {atCap && (
              <p className="text-[10px] text-muted-foreground">
                All {seatCap} seat{seatCap === 1 ? "’s" : "s’"} vouchers issued — revoke one to issue another.
                {userRole === "admin" ? " Admins can override with a reason." : ""}
              </p>
            )}
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

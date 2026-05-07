"use client";

/**
 * SharePaymentLinkDialog — multi-channel send for the booking payment
 * link. Replaces the prior single "Send Payment Link" button.
 *
 * Channels:
 *   - Email   → server-side send via the existing payment_link email
 *               flow. Webhook flips booking → paid on completion.
 *   - WhatsApp → opens wa.me/<phone>?text=... in a new tab. Staff hits
 *               send in the WhatsApp client. No MSG91 template
 *               registration needed.
 *   - SMS     → opens sms:<phone>?body=... — staff hits send in their
 *               native SMS app.
 *   - Copy    → clipboard, for any other channel (email cc, Slack, etc.)
 *
 * The link is transaction-specific — Razorpay assigns a unique
 * payment_link_id and our /api/payments/webhook flips the booking to
 * "paid" automatically when the customer completes payment, regardless
 * of which method they pick on the Razorpay page.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail, MessageCircle, Smartphone, Copy, ExternalLink, Link2, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  bookingNumber: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  amount: number;
  /** Lazily-resolved Razorpay link (or internal /pay/[token] fallback) */
  ensurePaymentLink: () => Promise<string | null>;
  internalLinkFallback: string;
  /** Called after at least one channel was sent so the parent can
      start polling for the webhook → paid transition. */
  onSent: () => void;
}

export function SharePaymentLinkDialog({
  open, onOpenChange, bookingId, bookingNumber, customerName,
  customerEmail, customerPhone, amount,
  ensurePaymentLink, internalLinkFallback, onSent,
}: Props) {
  const [paymentUrl, setPaymentUrl] = useState<string>("");
  const [isRazorpay, setIsRazorpay] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  // Resolve the link the moment the dialog opens. The "Pay Now" link
  // sent by every channel must be the same instance so all webhooks /
  // status-checks flow back to the same payment_link_id.
  useEffect(() => {
    if (!open) {
      setPaymentUrl("");
      setIsRazorpay(false);
      setEmailSent(false);
      return;
    }
    setResolving(true);
    ensurePaymentLink()
      .then((rzpUrl) => {
        if (rzpUrl) {
          setPaymentUrl(rzpUrl);
          setIsRazorpay(true);
        } else {
          setPaymentUrl(internalLinkFallback);
          setIsRazorpay(false);
        }
      })
      .finally(() => setResolving(false));
  }, [open, ensurePaymentLink, internalLinkFallback]);

  const sendEmail = async () => {
    if (!customerEmail) {
      toast.error("No customer email on file. Add one to the lead, or use WhatsApp/SMS instead.");
      return;
    }
    setEmailSending(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment_link",
          razorpay_payment_link_url: isRazorpay ? paymentUrl : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to send email");
        return;
      }
      setEmailSent(true);
      onSent();
      toast.success(`Payment link emailed to ${customerEmail}`, {
        description: isRazorpay
          ? "Payment status will update automatically once the customer pays."
          : "Internal link — staff to confirm payment manually after collection.",
      });
    } finally {
      setEmailSending(false);
    }
  };

  const composeWhatsApp = () => {
    if (!customerPhone) {
      toast.error("No customer phone on file");
      return;
    }
    const text = encodeURIComponent(
      `Hi ${customerName}, please complete the payment of ${formatCurrency(amount)} for your booking ${bookingNumber} at The WorkVilla:\n\n${paymentUrl}\n\nThank you!`
    );
    // wa.me requires the digits-only number with country code, no +
    const cleanPhone = customerPhone.replace(/[^0-9]/g, "");
    const phoneWithCC = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
    window.open(`https://wa.me/${phoneWithCC}?text=${text}`, "_blank", "noopener");
    onSent();
  };

  const composeSms = () => {
    if (!customerPhone) {
      toast.error("No customer phone on file");
      return;
    }
    const text = encodeURIComponent(
      `Hi ${customerName}, pay ${formatCurrency(amount)} for booking ${bookingNumber}: ${paymentUrl}`
    );
    window.open(`sms:${customerPhone}?body=${text}`, "_self");
    onSent();
  };

  const copyLink = () => {
    if (!paymentUrl) return;
    navigator.clipboard.writeText(paymentUrl)
      .then(() => toast.success(isRazorpay ? "Razorpay link copied" : "Payment link copied"))
      .catch(() => toast.error("Failed to copy"));
  };

  const openLink = () => {
    if (!paymentUrl) return;
    window.open(paymentUrl, "_blank", "noopener");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-[#015E65]" />
            Share Payment Link
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Booking summary */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Booking</span>
              <span className="font-mono text-xs">{bookingNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Customer</span>
              <span>{customerName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-semibold">{formatCurrency(amount)}</span>
            </div>
          </div>

          {/* Resolved link — visible so staff can verify before sending */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              Payment link
              {isRazorpay && (
                <span className="ml-1.5 text-[10px] text-emerald-700 font-normal">
                  · Razorpay (auto-confirms)
                </span>
              )}
            </Label>
            {resolving ? (
              <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Generating transaction-specific link…
              </div>
            ) : (
              <div className="flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1.5">
                <Input
                  readOnly
                  value={paymentUrl}
                  className="h-7 text-xs font-mono border-0 bg-transparent px-1 focus-visible:ring-0 shadow-none"
                />
                <button
                  type="button"
                  onClick={copyLink}
                  className="shrink-0 text-muted-foreground hover:text-foreground p-1"
                  title="Copy link"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={openLink}
                  className="shrink-0 text-muted-foreground hover:text-foreground p-1"
                  title="Open link"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {!isRazorpay && !resolving && paymentUrl && (
              <p className="text-[11px] text-amber-700">
                Razorpay couldn&apos;t generate a link — using the internal /pay link instead.
                Payment status won&apos;t auto-update; staff must mark paid after collection.
              </p>
            )}
          </div>

          {/* Channels */}
          <div className="space-y-2">
            <Label className="text-xs">Send via</Label>

            {/* Email — server-side */}
            <button
              type="button"
              onClick={sendEmail}
              disabled={!paymentUrl || !customerEmail || emailSending}
              className="w-full flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5 text-sm hover:bg-muted/40 active:scale-[0.99] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Mail className="h-4 w-4 text-blue-600 shrink-0" />
                <div className="text-left min-w-0">
                  <div className="font-medium">Email</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {customerEmail || "— no email on file —"}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-xs">
                {emailSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : emailSent ? (
                  <span className="flex items-center gap-1 text-emerald-700">
                    <CheckCircle className="h-3.5 w-3.5" /> Sent
                  </span>
                ) : (
                  <span className="text-muted-foreground">Send</span>
                )}
              </div>
            </button>

            {/* WhatsApp — opens wa.me */}
            <button
              type="button"
              onClick={composeWhatsApp}
              disabled={!paymentUrl || !customerPhone}
              className="w-full flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5 text-sm hover:bg-muted/40 active:scale-[0.99] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <MessageCircle className="h-4 w-4 text-green-600 shrink-0" />
                <div className="text-left min-w-0">
                  <div className="font-medium">WhatsApp</div>
                  <div className="text-[11px] text-muted-foreground">
                    {customerPhone || "— no phone on file —"} · opens chat with link pre-filled
                  </div>
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">Open</span>
            </button>

            {/* SMS — opens sms: */}
            <button
              type="button"
              onClick={composeSms}
              disabled={!paymentUrl || !customerPhone}
              className="w-full flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5 text-sm hover:bg-muted/40 active:scale-[0.99] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Smartphone className="h-4 w-4 text-amber-600 shrink-0" />
                <div className="text-left min-w-0">
                  <div className="font-medium">SMS</div>
                  <div className="text-[11px] text-muted-foreground">
                    {customerPhone || "— no phone on file —"} · opens SMS app with link pre-filled
                  </div>
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">Open</span>
            </button>
          </div>

          {/* Confirmation note */}
          {isRazorpay && (
            <div className="rounded-md bg-blue-50 border border-blue-200 p-2.5 text-[11px] text-blue-900">
              <strong>How confirmation works:</strong> the Razorpay payment link is unique to this booking.
              When the customer pays, our webhook auto-marks this booking as paid — the page will refresh
              the status automatically.
            </div>
          )}

          <div className="flex justify-end pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { OTP_EXPIRY_MINUTES } from "@/lib/constants";

interface NoShowRefundDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  bookingNumber: string;
  totalAmount: number;
  customerName: string;
  onSuccess: () => void;
}

type Step = "confirm" | "otp" | "success";

export function NoShowRefundDialog({
  open,
  onOpenChange,
  bookingId,
  bookingNumber,
  totalAmount,
  customerName,
  onSuccess,
}: NoShowRefundDialogProps) {
  const [step, setStep] = useState<Step>("confirm");
  const [reason, setReason] = useState("");
  const [refundAmount, setRefundAmount] = useState(totalAmount);
  const [otpId, setOtpId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [sentToCount, setSentToCount] = useState(0);

  const resetState = () => {
    setStep("confirm");
    setReason("");
    setRefundAmount(totalAmount);
    setOtpId("");
    setOtpCode("");
    setLoading(false);
    setExpiresAt(null);
    setSentToCount(0);
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) resetState();
    onOpenChange(isOpen);
  };

  // Step 1: Request OTP for refund authorization
  const handleRequestOTP = async () => {
    if (!reason.trim()) {
      toast.error("Please enter a reason for the refund exception");
      return;
    }
    if (refundAmount <= 0 || refundAmount > totalAmount) {
      toast.error(`Refund amount must be between ₹1 and ${formatCurrency(totalAmount)}`);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/admin/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference_id: bookingId,
          purpose: `no_show_refund:${bookingNumber}:${customerName}:${formatCurrency(refundAmount)}`,
        }),
      });

      const json = await res.json();

      if (res.ok) {
        setOtpId(json.otp_id);
        setExpiresAt(json.expires_at);
        setSentToCount(json.sent_to_count);
        setStep("otp");
        toast.success(`OTP sent to ${json.sent_to_count} admin/manager(s)`);
      } else {
        toast.error(json.error || "Failed to generate OTP");
      }
    } catch {
      toast.error("Failed to request OTP");
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Verify OTP & Process Refund
  const handleVerifyAndProcess = async () => {
    if (otpCode.length !== 6) {
      toast.error("Enter a 6-digit OTP code");
      return;
    }

    setLoading(true);
    try {
      // First verify OTP
      const verifyRes = await fetch("/api/admin/otp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp_id: otpId, otp_code: otpCode }),
      });

      const verifyJson = await verifyRes.json();

      if (!verifyRes.ok || !verifyJson.valid) {
        toast.error(verifyJson.reason || "OTP verification failed");
        setLoading(false);
        return;
      }

      // Then update booking with refund info
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refund_status: "approved",
          refund_amount: refundAmount,
          refund_reason: reason.trim(),
        }),
      });

      if (res.ok) {
        setStep("success");
        toast.success("Refund exception approved and logged");
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to process refund");
      }
    } catch {
      toast.error("Failed to process refund");
    } finally {
      setLoading(false);
    }
  };

  const getTimeRemaining = () => {
    if (!expiresAt) return "";
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return "Expired";
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-orange-600" />
            No-Show Refund Exception — {bookingNumber}
          </DialogTitle>
          <DialogDescription>
            {step === "confirm" && "Standard policy: No refund for no-shows. An OTP from admin/manager is required for exceptions."}
            {step === "otp" && "Enter the OTP sent to admin/manager users to authorize the refund."}
            {step === "success" && "Refund exception has been approved and logged."}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Confirm & Enter Details */}
        {step === "confirm" && (
          <div className="space-y-4">
            <div className="rounded-md border-amber-200 bg-amber-50 border p-3 text-sm space-y-1">
              <div className="flex items-center gap-2 text-amber-800 font-medium">
                <AlertTriangle className="h-4 w-4" />
                No-Show — No Refund Policy
              </div>
              <p className="text-amber-700 text-xs">
                General terms state no refund for no-shows. An exception requires OTP authorization from an Admin or Manager.
              </p>
            </div>

            <div className="rounded-md border p-3 bg-muted/50 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Customer</span>
                <span className="font-medium">{customerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Booking Amount</span>
                <span className="font-medium">{formatCurrency(totalAmount)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="refund-amount">Refund Amount *</Label>
              <Input
                id="refund-amount"
                type="number"
                min={1}
                max={totalAmount}
                step={1}
                value={refundAmount}
                onChange={(e) => setRefundAmount(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Full or partial refund up to {formatCurrency(totalAmount)}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="refund-reason">Reason for Exception *</Label>
              <Textarea
                id="refund-reason"
                placeholder="e.g., Medical emergency, first-time customer goodwill..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              An OTP will be emailed to all admin and manager users with the booking details and cancellation note.
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
              <Button
                onClick={handleRequestOTP}
                disabled={loading || !reason.trim() || refundAmount <= 0 || refundAmount > totalAmount}
                className="bg-orange-600 hover:bg-orange-700 text-white"
              >
                {loading ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Requesting...</>
                ) : (
                  "Request OTP Authorization"
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Enter OTP */}
        {step === "otp" && (
          <div className="space-y-4">
            <div className="text-center text-sm text-muted-foreground">
              OTP has been sent to <strong>{sentToCount}</strong> admin/manager user{sentToCount !== 1 ? "s" : ""}.
              <br />
              Expires in <strong>{OTP_EXPIRY_MINUTES} minutes</strong>
              {expiresAt && (
                <span className="ml-1 text-xs">({getTimeRemaining()} remaining)</span>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Refund Amount</span>
                <span className="font-bold text-orange-700">{formatCurrency(refundAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reason</span>
                <span className="truncate max-w-[200px]">{reason}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="otp">Enter 6-Digit OTP</Label>
              <Input
                id="otp"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="text-center text-2xl font-mono tracking-[0.3em] h-14"
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep("confirm")}>Back</Button>
              <Button
                onClick={handleVerifyAndProcess}
                disabled={loading || otpCode.length !== 6}
                className="bg-orange-600 hover:bg-orange-700 text-white"
              >
                {loading ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Verifying...</>
                ) : (
                  "Verify & Approve Refund"
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Success */}
        {step === "success" && (
          <div className="space-y-4">
            <div className="text-center space-y-3">
              <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
              <div>
                <p className="font-medium text-lg">Refund Exception Approved</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Refund of <strong className="text-orange-700">{formatCurrency(refundAmount)}</strong> for {bookingNumber} has been authorized and logged.
                </p>
              </div>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>This refund is now marked for processing.</p>
                <p>The authorization details have been recorded in the audit trail.</p>
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={() => handleClose(false)}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

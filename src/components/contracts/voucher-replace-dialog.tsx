"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { OTP_EXPIRY_MINUTES } from "@/lib/constants";

interface VoucherReplaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string;
  issuanceId: string;
  seatNumber: number;
  currentVoucherCode: string;
  seatEmail?: string;
  onSuccess: () => void;
}

type Step = "confirm" | "otp" | "success";

export function VoucherReplaceDialog({
  open,
  onOpenChange,
  contractId,
  issuanceId,
  seatNumber,
  currentVoucherCode,
  seatEmail,
  onSuccess,
}: VoucherReplaceDialogProps) {
  const [step, setStep] = useState<Step>("confirm");
  const [reason, setReason] = useState("");
  const [otpId, setOtpId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [newVoucherCode, setNewVoucherCode] = useState("");
  const [sentToCount, setSentToCount] = useState(0);

  const resetState = () => {
    setStep("confirm");
    setReason("");
    setOtpId("");
    setOtpCode("");
    setLoading(false);
    setExpiresAt(null);
    setNewVoucherCode("");
    setSentToCount(0);
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) resetState();
    onOpenChange(isOpen);
  };

  // Step 1: Request OTP
  const handleRequestOTP = async () => {
    if (!reason.trim()) {
      toast.error("Please enter a reason for replacement");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/admin/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference_id: issuanceId,
          purpose: "voucher_replacement",
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

  // Step 2: Verify OTP & Replace
  const handleVerifyAndReplace = async () => {
    if (otpCode.length !== 6) {
      toast.error("Enter a 6-digit OTP code");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `/api/contracts/${contractId}/vouchers/${issuanceId}/replace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            otp_id: otpId,
            otp_code: otpCode,
            revoke_reason: reason,
          }),
        }
      );

      const json = await res.json();

      if (res.ok) {
        setNewVoucherCode(json.new_voucher_code || "");
        setStep("success");
        toast.success("Voucher replaced successfully");
        onSuccess();
      } else {
        toast.error(json.error || "Replacement failed");
      }
    } catch {
      toast.error("Replacement failed");
    } finally {
      setLoading(false);
    }
  };

  // Compute time remaining for OTP
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
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-orange-600" />
            Replace Voucher — Seat #{seatNumber}
          </DialogTitle>
          <DialogDescription>
            {step === "confirm" && "This will revoke the current voucher and issue a new one."}
            {step === "otp" && "Enter the OTP sent to admin/manager users."}
            {step === "success" && "Voucher has been replaced successfully."}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Confirm & Enter Reason */}
        {step === "confirm" && (
          <div className="space-y-4">
            <div className="rounded-md border p-3 bg-muted/50 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Current Code</span>
                <span className="font-mono font-medium">{currentVoucherCode}</span>
              </div>
              {seatEmail && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Occupant</span>
                  <span>{seatEmail}</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="reason">Reason for Replacement</Label>
              <Textarea
                id="reason"
                placeholder="e.g., Device change — new laptop"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" />
              An OTP will be emailed to all admin and manager users for authorization.
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleRequestOTP}
                disabled={loading || !reason.trim()}
                className="bg-orange-600 hover:bg-orange-700 text-white"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Requesting...
                  </>
                ) : (
                  "Request OTP"
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
              <Button variant="outline" onClick={() => setStep("confirm")}>
                Back
              </Button>
              <Button
                onClick={handleVerifyAndReplace}
                disabled={loading || otpCode.length !== 6}
                className="bg-orange-600 hover:bg-orange-700 text-white"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify & Replace"
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
                <p className="text-sm text-muted-foreground">Old code revoked</p>
                <p className="font-mono text-sm line-through text-red-500">{currentVoucherCode}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">New code issued</p>
                <p className="font-mono text-lg font-bold text-green-700">{newVoucherCode}</p>
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={() => handleClose(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

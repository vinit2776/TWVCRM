"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface WaiverRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  waiverType: "overtime" | "extension" | "other";
  waiverAmount: number;
  /** Called when waiver is successfully approved */
  onApproved: () => void;
}

type Step = "request" | "verify";

export function WaiverRequestDialog({
  open,
  onOpenChange,
  bookingId,
  waiverType,
  waiverAmount,
  onApproved,
}: WaiverRequestDialogProps) {
  const [step, setStep] = useState<Step>("request");
  const [note, setNote] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const handleRequest = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/waiver-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waiver_type: waiverType, waiver_amount: waiverAmount, note: note.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to send waiver request");
        return;
      }
      setExpiresAt(json.data?.expires_at || null);
      setStep("verify");
      toast.success("Waiver request sent to managers. Share the OTP with the floor manager once approved.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!otp.trim() || otp.trim().length !== 6) {
      toast.error("Please enter the 6-digit OTP received from the manager");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/waiver-request`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp: otp.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "OTP verification failed");
        return;
      }
      toast.success("Waiver approved by manager. Charge has been waived.");
      onApproved();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setStep("request");
    setNote("");
    setOtp("");
    setExpiresAt(null);
    onOpenChange(false);
  };

  const typeLabel = waiverType === "overtime" ? "Overtime" : waiverType === "extension" ? "Extension" : "Charge";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-amber-600" />
            Request {typeLabel} Waiver
          </DialogTitle>
        </DialogHeader>

        {step === "request" ? (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold text-amber-800">Waiver Amount: ₹{waiverAmount.toLocaleString("en-IN")}</p>
                  <p className="text-amber-700 text-xs mt-0.5">
                    A manager will receive the booking details and an OTP to share with you for approval.
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Reason / Note <span className="text-muted-foreground font-normal text-xs">(visible to manager)</span></Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Customer had technical issues, equipment failure..."
                rows={3}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
              <p className="font-semibold text-green-800">OTP sent to managers</p>
              <p className="text-green-700 text-xs mt-0.5">
                The manager will receive booking details and the OTP via WhatsApp/SMS. Ask them to share the OTP with you to confirm approval.
                {expiresAt && (
                  <> Valid until {new Date(expiresAt).toLocaleTimeString()}.</>
                )}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Enter OTP from Manager</Label>
              <Input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6-digit OTP"
                maxLength={6}
                inputMode="numeric"
                className="text-center text-lg tracking-widest font-mono"
                autoFocus
              />
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => { setStep("request"); setOtp(""); }}
            >
              Re-send waiver request
            </button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          {step === "request" ? (
            <Button onClick={handleRequest} disabled={loading} className="bg-amber-600 hover:bg-amber-700 text-white">
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Send to Manager
            </Button>
          ) : (
            <Button onClick={handleVerify} disabled={loading || otp.length < 6}>
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Confirm Waiver
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

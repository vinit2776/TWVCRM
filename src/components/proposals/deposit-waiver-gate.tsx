"use client";

import { useState } from "react";
import { ShieldAlert, KeyRound, RefreshCw, CheckCircle2, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

interface Props {
  proposalId: string;
  proposalNumber: string;
  isVerified: boolean;
  requestedAt?: string | null;
  verifiedByName?: string | null;
  internalNotes?: string | null;
  onVerified: () => void;
}

export function DepositWaiverGate({ proposalId, proposalNumber, isVerified, requestedAt, verifiedByName, internalNotes, onVerified }: Props) {
  const [otp, setOtp] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const hasRequested = !!requestedAt;

  if (isVerified) {
    return (
      <Card className="border-green-200 bg-green-50">
        <CardContent className="py-4 space-y-1.5">
          <div className="flex items-center gap-2 text-green-700">
            <CheckCircle2 className="h-5 w-5" />
            <p className="text-sm font-medium">
              Deposit waiver approved — proposal unlocked
              {verifiedByName && <span className="font-normal"> · by {verifiedByName}</span>}
            </p>
          </div>
          {internalNotes && (
            <p className="text-xs text-green-700/80 italic pl-7">{internalNotes}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  const handleRequest = async (action: "request" | "resend") => {
    setRequesting(true);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-waiver-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.message);
        onVerified(); // refresh to get updated requestedAt
      } else {
        toast.error(json.error || "Failed to send OTP");
      }
    } catch {
      toast.error("Unexpected error");
    } finally {
      setRequesting(false);
    }
  };

  const handleVerify = async () => {
    if (otp.length !== 6) {
      toast.error("Please enter the 6-digit OTP");
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-waiver-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", otp }),
      });
      const json = await res.json();
      if (res.ok && json.verified) {
        toast.success(json.message);
        onVerified();
      } else {
        toast.error(json.error || "Verification failed");
      }
    } catch {
      toast.error("Unexpected error");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-amber-800 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          Admin Approval Required — Zero Deposit
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-amber-200 bg-white px-4 py-3 space-y-2">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-800 space-y-1">
              <p className="font-semibold">Why is this proposal locked?</p>
              <p>This proposal has no security deposit selected. As per company policy, zero-deposit proposals require admin approval before they can be sent to the customer or downloaded as PDF.</p>
              <p className="font-medium">How to unlock:</p>
              <ol className="list-decimal list-inside space-y-0.5 ml-1">
                <li>Click &quot;Request Admin Approval&quot; — an OTP will be emailed to all admins</li>
                <li>Your admin will review the proposal details and share the OTP if approved</li>
                <li>Enter the 6-digit OTP below to unlock the proposal</li>
              </ol>
              <p className="text-amber-600 italic">Alternatively, change the security deposit to 1 or more months to bypass this requirement.</p>
            </div>
          </div>
        </div>

        {!hasRequested ? (
          <Button
            className="w-full bg-amber-600 hover:bg-amber-700 text-white"
            onClick={() => handleRequest("request")}
            disabled={requesting}
          >
            {requesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
            {requesting ? "Sending OTP to Admins…" : "Request Admin Approval"}
          </Button>
        ) : (
          <>
            <div className="flex gap-2">
              <Input
                placeholder="Enter 6-digit OTP"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                maxLength={6}
                className="font-mono text-center text-lg tracking-widest"
                onKeyDown={(e) => { if (e.key === "Enter") handleVerify(); }}
              />
              <Button
                onClick={handleVerify}
                disabled={verifying || otp.length !== 6}
                className="bg-green-600 hover:bg-green-700 text-white shrink-0"
              >
                {verifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                {verifying ? "Verifying…" : "Verify"}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-amber-700 hover:text-amber-800 hover:bg-amber-100"
              onClick={() => handleRequest("resend")}
              disabled={requesting}
            >
              {requesting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              {requesting ? "Resending…" : "Resend OTP to Admins"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

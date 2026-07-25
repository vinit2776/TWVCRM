"use client";

/**
 * LinkRuijieVoucherDialog — manually link an already-issued Ruijie voucher
 * (issued outside the CRM, e.g. by IT before this integration) to a contract
 * seat.
 *
 * Deliberately a lookup-by-exact-code flow, never a search or suggestion —
 * staff must have already verified the code belongs to the right customer's
 * device (e.g. checked it against the "Connected Clients" panel) before
 * typing it in here.
 */

import { useState } from "react";
import { Loader2, Link2, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface RuijieVoucherPreview {
  uuid: string;
  code: string;
  packageName: string;
  status: string; // "1" unused | "2" in-use | "3" expired
  currentClients: number;
  maxClients: number;
  expiryTime: number | null;
  comment: string;
}

const STATUS_LABEL: Record<string, string> = { "1": "Unused", "2": "In use", "3": "Expired" };

interface LinkRuijieVoucherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string;
  memberId?: string;
  memberName: string;
  seatNumber: number;
  onSuccess: () => void;
}

export function LinkRuijieVoucherDialog({
  open, onOpenChange, contractId, memberId, memberName, seatNumber, onSuccess,
}: LinkRuijieVoucherDialogProps) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<RuijieVoucherPreview | null>(null);
  const [looking, setLooking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCode(""); setPreview(null); setError(null); setLooking(false); setConfirming(false);
  }

  async function handleLookup() {
    if (!code.trim()) { toast.error("Enter the voucher code"); return; }
    setLooking(true); setError(null);
    try {
      const res = await fetch(`/api/contracts/${contractId}/vouchers/link-ruijie`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: memberId, seat_number: seatNumber, voucher_code: code.trim() }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || "Voucher not found"); return; }
      setPreview(json.preview);
    } catch {
      setError("Failed to reach the server");
    } finally {
      setLooking(false);
    }
  }

  async function handleConfirm() {
    setConfirming(true); setError(null);
    try {
      const res = await fetch(`/api/contracts/${contractId}/vouchers/link-ruijie`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: memberId, seat_number: seatNumber, voucher_code: code.trim(), confirm: true }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || "Failed to link voucher"); return; }
      toast.success(`Voucher linked to ${memberName}`);
      onOpenChange(false);
      reset();
      onSuccess();
    } catch {
      setError("Failed to reach the server");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            Link Existing Voucher — {memberName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Only use this after verifying the code against the customer&apos;s actual connected device
              (check the &quot;Connected Clients&quot; list on the location&apos;s Vouchers page). Never guess from the
              package name alone.
            </span>
          </div>

          {!preview ? (
            <div className="space-y-1.5">
              <Label>Verified voucher code</Label>
              <Input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. 5e7d3e"
                onKeyDown={(e) => e.key === "Enter" && handleLookup()}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 className="h-4 w-4" />
                Found — confirm this is the right voucher before linking
              </div>
              <div className="rounded-md border divide-y text-sm">
                <div className="flex justify-between px-3 py-2">
                  <span className="text-muted-foreground">Code</span>
                  <span className="font-mono font-semibold">{preview.code}</span>
                </div>
                <div className="flex justify-between px-3 py-2">
                  <span className="text-muted-foreground">Package</span>
                  <span>{preview.packageName}</span>
                </div>
                <div className="flex justify-between px-3 py-2">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant="secondary" className="text-xs">{STATUS_LABEL[preview.status] || preview.status}</Badge>
                </div>
                <div className="flex justify-between px-3 py-2">
                  <span className="text-muted-foreground">Devices</span>
                  <span>{preview.currentClients}/{preview.maxClients}</span>
                </div>
                {preview.comment && (
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Comment</span>
                    <span>{preview.comment}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {!preview ? (
              <Button onClick={handleLookup} disabled={looking}>
                {looking ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Looking up…</> : "Look Up Voucher"}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => { setPreview(null); setError(null); }}>Back</Button>
                <Button onClick={handleConfirm} disabled={confirming}>
                  {confirming ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Linking…</> : "Confirm Link"}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

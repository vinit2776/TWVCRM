"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  ArrowRight,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import type { Contract } from "@/types";

// ─── Renewal Dialog ─────────────────────────────────────────────────────────

interface RenewalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: Contract;
  userRole: string | null;
  onSuccess: () => void;
}

export function ContractRenewalDialog({
  open,
  onOpenChange,
  contract,
  userRole,
  onSuccess,
}: RenewalDialogProps) {
  const [renewing, setRenewing] = useState(false);
  const [tenureMonths, setTenureMonths] = useState(contract.tenure_months);
  const [startDate, setStartDate] = useState(() => {
    // Default start date: day after contract end_date
    const end = new Date(contract.end_date);
    end.setDate(end.getDate() + 1);
    return end.toISOString().slice(0, 10);
  });

  const escalationPct = contract.escalation_percentage || 0;
  const multiplier = 1 + escalationPct / 100;
  const currentSubtotal = Number(contract.subtotal);
  const newSubtotal = Math.round(currentSubtotal * multiplier * 100) / 100;
  const currentTotal = Number(contract.total_amount);
  const newTotal = Math.round(currentTotal * multiplier * 100) / 100;

  const handleRenew = async () => {
    setRenewing(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenure_months: tenureMonths,
          start_date: startDate,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        toast.success(
          `Renewal draft created: ${json.data.contract_number}`,
          {
            action: {
              label: "Open",
              onClick: () => window.open(`/contracts/${json.data.id}`, "_blank"),
            },
          }
        );
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to create renewal");
      }
    } catch {
      toast.error("Network error — please try again");
    }
    setRenewing(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            Renew Contract
          </DialogTitle>
          <DialogDescription>
            Create a renewal draft for {contract.contract_number} with escalated rental.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Escalation Preview */}
          <div className="rounded-md border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Annual Escalation</span>
              <Badge variant="secondary">{escalationPct}%</Badge>
            </div>
            <Separator />
            <div className="grid grid-cols-3 gap-2 text-sm text-center">
              <div>
                <p className="text-muted-foreground text-xs mb-1">Current</p>
                <p className="font-mono font-semibold">{formatCurrency(currentSubtotal)}</p>
              </div>
              <div className="flex items-center justify-center">
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">Renewed</p>
                <p className="font-mono font-semibold text-primary">{formatCurrency(newSubtotal)}</p>
              </div>
            </div>
            {escalationPct > 0 && (
              <p className="text-xs text-muted-foreground text-center">
                Monthly rental: {formatCurrency(currentTotal)} → {formatCurrency(newTotal)} (incl. tax)
              </p>
            )}
          </div>

          {/* Renewal Parameters */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="renewal-tenure">Tenure (months)</Label>
              <Input
                id="renewal-tenure"
                type="number"
                min={1}
                max={120}
                value={tenureMonths}
                onChange={(e) => setTenureMonths(parseInt(e.target.value) || contract.tenure_months)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="renewal-start">Start Date</Label>
              <Input
                id="renewal-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
          </div>

          {/* Info */}
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-800 space-y-1">
            <p className="font-semibold">What happens on renewal:</p>
            <ul className="list-disc list-inside space-y-0.5 text-blue-700">
              <li>A new <strong>draft</strong> contract is created with escalated rates</li>
              <li>KYC documents and space allocations carry over automatically</li>
              <li>Security deposit rolls forward — no re-collection</li>
              <li>Current contract status changes to &quot;Renewed&quot;</li>
              <li>New vouchers will be issued when the renewal is activated</li>
            </ul>
          </div>

          {userRole === "admin" && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              Escalation can be waived after the renewal draft is created.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleRenew} disabled={renewing}>
            {renewing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Create Renewal Draft
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Decline Renewal Dialog ─────────────────────────────────────────────────

interface DeclineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: Contract;
  onSuccess: () => void;
}

export function DeclineRenewalDialog({
  open,
  onOpenChange,
  contract,
  onSuccess,
}: DeclineDialogProps) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const handleDecline = async () => {
    if (!reason.trim()) {
      toast.error("Please provide a reason for declining");
      return;
    }
    setDeclining(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/decline-renewal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });

      if (res.ok) {
        toast.success("Renewal declined");
        setReason("");
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to decline renewal");
      }
    } catch {
      toast.error("Network error — please try again");
    }
    setDeclining(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <XCircle className="h-4 w-4" />
            Decline Renewal
          </DialogTitle>
          <DialogDescription>
            Record that the customer has declined to renew {contract.contract_number}.
            This does not terminate the contract.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="decline-reason">
            Reason <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="decline-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., Customer relocating, switching to competitor, downsizing..."
            rows={3}
          />
        </div>

        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p>
            <strong>Note:</strong> This only records the customer&apos;s decision. The contract
            will continue until its end date. No further renewal reminders will be sent.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDecline}
            disabled={declining || !reason.trim()}
          >
            {declining ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Declining...
              </>
            ) : (
              "Decline Renewal"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Escalation Waiver Section (inline, for admin on renewal drafts) ────────

interface EscalationWaiverProps {
  contractId: string;
  escalationWaived: boolean;
  waiverReason: string | null;
  userRole: string | null;
  onSuccess: () => void;
}

export function EscalationWaiverSection({
  contractId,
  escalationWaived,
  waiverReason,
  userRole,
  onSuccess,
}: EscalationWaiverProps) {
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [showForm, setShowForm] = useState(false);

  if (userRole !== "admin") return null;

  const handleToggle = async (waive: boolean) => {
    if (waive && !reason.trim()) {
      toast.error("Please provide a waiver reason");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/renew`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waive_escalation: waive,
          waiver_reason: waive ? reason.trim() : undefined,
        }),
      });

      if (res.ok) {
        toast.success(waive ? "Escalation waived — prices restored to parent rates" : "Escalation re-applied");
        setShowForm(false);
        setReason("");
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update escalation waiver");
      }
    } catch {
      toast.error("Network error");
    }
    setLoading(false);
  };

  return (
    <div className="border border-dashed border-amber-300 rounded-lg p-3 bg-amber-50/50 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-amber-800 flex items-center gap-1">
          <ShieldAlert className="h-3 w-3" />
          Escalation Waiver (Admin)
        </p>
        {escalationWaived && (
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-[10px]">
            Waived
          </Badge>
        )}
      </div>

      {escalationWaived ? (
        <div className="space-y-1.5">
          <p className="text-xs text-amber-700">
            Reason: <span className="font-medium">{waiverReason}</span>
          </p>
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-7"
            disabled={loading}
            onClick={() => handleToggle(false)}
          >
            {loading && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Re-apply Escalation
          </Button>
        </div>
      ) : !showForm ? (
        <button
          className="text-xs text-amber-700 underline hover:text-amber-900"
          onClick={() => setShowForm(true)}
        >
          Waive escalation for this renewal
        </button>
      ) : (
        <div className="space-y-2">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for waiving escalation..."
            className="text-sm h-8"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-7 border-amber-400 text-amber-800 hover:bg-amber-100"
              disabled={!reason.trim() || loading}
              onClick={() => handleToggle(true)}
            >
              {loading && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Waive Escalation
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-7"
              onClick={() => { setShowForm(false); setReason(""); }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

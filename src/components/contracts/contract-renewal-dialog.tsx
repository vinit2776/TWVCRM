"use client";

import { useState, useMemo } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  ArrowRight,
  ShieldAlert,
  XCircle,
  CalendarX,
  HelpCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BILLING_CYCLE_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import type { Contract } from "@/types";

// ─── Field Help Tooltip ─────────────────────────────────────────────────────

function FieldHelp({ tip }: { tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <HelpCircle className="h-3 w-3 text-muted-foreground/60 hover:text-blue-500 cursor-help inline-block ml-1 shrink-0" />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-xs">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

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
  const [seats, setSeats] = useState(contract.seats || 1);
  const [billingCycle, setBillingCycle] = useState<string>(contract.billing_cycle || "monthly");
  const [escalationPct, setEscalationPct] = useState(contract.escalation_percentage || 0);
  const [startDate, setStartDate] = useState(() => {
    const end = new Date(contract.end_date);
    end.setDate(end.getDate() + 1);
    return end.toISOString().slice(0, 10);
  });

  // Round to nearest Rs 10
  const roundToTen = (n: number) => Math.round(n / 10) * 10;

  const currentSubtotal = Number(contract.subtotal);
  const multiplier = 1 + escalationPct / 100;

  // Preview: compute escalated subtotal per-item then sum (matches API logic)
  type Item = { unit_price: number; quantity: number };
  const previewSubtotal = useMemo(() => {
    const items = (contract.items || []) as Item[];
    return items.reduce((sum, item) => {
      const newPrice = roundToTen(item.unit_price * multiplier);
      return sum + newPrice * item.quantity;
    }, 0);
  }, [contract.items, multiplier]);

  const taxPct = Number(contract.tax_percentage || 18);
  const discountPct = Number(contract.discount_percentage || 0);
  const previewDiscount = Math.round(previewSubtotal * (discountPct / 100));
  const previewTaxable = previewSubtotal - previewDiscount;
  const previewTax = Math.round(previewTaxable * (taxPct / 100));
  const previewTotal = previewTaxable + previewTax;

  // Calculate end date preview
  const previewEndDate = useMemo(() => {
    if (!startDate || !tenureMonths) return "";
    const start = new Date(startDate);
    start.setMonth(start.getMonth() + tenureMonths);
    start.setDate(start.getDate() - 1);
    return start.toISOString().split("T")[0];
  }, [startDate, tenureMonths]);

  // Gap calculation
  const gapDays = useMemo(() => {
    if (!startDate) return 0;
    const parentEnd = new Date(contract.end_date).getTime();
    const renewStart = new Date(startDate).getTime();
    return Math.max(0, Math.round((renewStart - parentEnd) / 86_400_000) - 1);
  }, [startDate, contract.end_date]);

  const handleRenew = async () => {
    setRenewing(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenure_months: tenureMonths,
          start_date: startDate,
          seats,
          billing_cycle: billingCycle,
          escalation_percentage: escalationPct,
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

  const [showGuide, setShowGuide] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <TooltipProvider delayDuration={200}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            Renew Contract — {contract.contract_number}
          </DialogTitle>
          <DialogDescription className="flex items-center justify-between">
            <span>Negotiate renewal terms. A draft addendum will be created for customer approval.</span>
            <button
              type="button"
              onClick={() => setShowGuide(!showGuide)}
              className="text-[10px] text-blue-600 hover:text-blue-800 underline underline-offset-2 shrink-0 ml-2"
            >
              {showGuide ? "Hide guide" : "First time? Quick guide"}
            </button>
          </DialogDescription>
        </DialogHeader>

        {/* Inline walkthrough guide */}
        {showGuide && (
          <div className="rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 space-y-2 text-xs text-blue-900">
            <p className="font-semibold flex items-center gap-1.5">
              <HelpCircle className="h-3.5 w-3.5" />
              How Renewal Works
            </p>
            <ol className="list-decimal list-inside space-y-1 text-[11px] leading-relaxed">
              <li><strong>Negotiate</strong> — Adjust escalation %, tenure, seats, and start date below. The rate preview updates live.</li>
              <li><strong>Create Draft</strong> — A new contract is created in Draft status, linked to this one. KYC and facilities carry over.</li>
              <li><strong>Addendum</strong> — Generate an addendum from the draft for the customer to sign (no full re-signing needed).</li>
              <li><strong>Activate</strong> — Once signed, activate the renewal. The current contract moves to &quot;Renewed&quot; status automatically.</li>
            </ol>
            <p className="text-[10px] text-blue-700">
              💡 Hover over <HelpCircle className="h-2.5 w-2.5 inline" /> icons next to fields for specific guidance.
            </p>
          </div>
        )}

        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
          {/* Rate Negotiation */}
          <div className="rounded-md border bg-muted/30 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rate Negotiation</p>
            <div className="grid grid-cols-3 gap-3 items-end">
              <div className="space-y-1">
                <Label className="text-xs">Escalation %<FieldHelp tip="Annual rate increase applied to each line item. Set to 0 for no change. The escalated rate is rounded to the nearest ₹10." /></Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={escalationPct}
                  onChange={(e) => setEscalationPct(parseFloat(e.target.value) || 0)}
                  className="h-9"
                />
              </div>
              <div className="text-center pb-2">
                <ArrowRight className="h-4 w-4 text-muted-foreground mx-auto" />
              </div>
              <div className="text-right pb-1">
                <p className="text-xs text-muted-foreground">Renewed Rate</p>
                <p className="font-mono font-bold text-lg text-primary">{formatCurrency(previewSubtotal)}</p>
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-3 gap-2 text-xs text-center">
              <div>
                <p className="text-muted-foreground">Current</p>
                <p className="font-mono font-semibold">{formatCurrency(currentSubtotal)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Change</p>
                <p className={`font-mono font-semibold ${previewSubtotal > currentSubtotal ? "text-red-600" : previewSubtotal < currentSubtotal ? "text-green-600" : ""}`}>
                  {previewSubtotal >= currentSubtotal ? "+" : ""}{formatCurrency(previewSubtotal - currentSubtotal)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Total (incl. tax)</p>
                <p className="font-mono font-semibold">{formatCurrency(previewTotal)}</p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground text-center">
              Rates rounded to nearest ₹10 for cleaner invoicing
            </p>
          </div>

          {/* Renewal Terms */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Renewal Terms</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="renewal-tenure">Tenure (months)<FieldHelp tip="Duration of the renewal contract. Can be shorter or longer than the current contract." /></Label>
                <Input
                  id="renewal-tenure"
                  type="number"
                  min={1}
                  max={120}
                  value={tenureMonths}
                  onChange={(e) => setTenureMonths(parseInt(e.target.value) || contract.tenure_months)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="renewal-seats">Seats<FieldHelp tip="Number of seats in the renewal. Changing seats may affect the security deposit requirement." /></Label>
                <Input
                  id="renewal-seats"
                  type="number"
                  min={1}
                  max={500}
                  value={seats}
                  onChange={(e) => setSeats(parseInt(e.target.value) || 1)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="renewal-billing">Billing Cycle<FieldHelp tip="How often invoices are generated. Changing the cycle does not change the total monthly rate." /></Label>
                <Select value={billingCycle} onValueChange={setBillingCycle}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(BILLING_CYCLE_LABELS).map(([val, label]) => (
                      <SelectItem key={val} value={val}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="renewal-start">Start Date<FieldHelp tip="Defaults to the day after the current contract ends. Changing this may create a gap — the member won't have an active contract during the gap." /></Label>
                <Input
                  id="renewal-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>
            {previewEndDate && (
              <p className="text-xs text-muted-foreground">
                Period: {formatDate(startDate)} → {formatDate(previewEndDate)} ({tenureMonths} months)
              </p>
            )}
          </div>

          {/* Gap Warning */}
          {gapDays > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 flex items-start gap-2">
              <CalendarX className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-800">
                <p className="font-semibold">{gapDays}-day gap between contracts</p>
                <p>
                  Current contract ends {formatDate(contract.end_date)}, renewal starts {formatDate(startDate)}.
                  The member will have no active contract during this gap.
                </p>
              </div>
            </div>
          )}

          {/* Seats change warning */}
          {seats !== (contract.seats || 1) && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Seats changing from {contract.seats || 1} → {seats}. Deposit shortfall may apply.
            </div>
          )}

          {/* What happens */}
          <div className="rounded-md border border-muted bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">What happens:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>A <strong>draft</strong> renewal contract is created with the negotiated terms</li>
              <li>KYC documents, space allocations, and facilities carry over</li>
              <li>Security deposit rolls forward — no re-collection needed</li>
              <li>Current contract stays <strong>active</strong> until the renewal is activated</li>
              <li>An addendum can be generated for customer sign-off</li>
            </ul>
          </div>

          {userRole === "admin" && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              Escalation can also be waived entirely after the draft is created.
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
        </TooltipProvider>
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

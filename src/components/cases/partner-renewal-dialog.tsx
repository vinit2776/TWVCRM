"use client";

/**
 * Confirm partner renewal — for a case billed monthly to a postpaid partner.
 * There is no renewal bill or payment link: the partner already pays monthly
 * for all their cases. A person records that the partner is continuing, the
 * length of the next term and the monthly fee from that term. Nothing is sent.
 *
 * The case moves into its new term on that term's first day (the partner is
 * invoiced by case status and the current rate for the month, so rolling
 * earlier would charge the new rate too soon). If that day has already passed
 * the case rolls over immediately.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  RENEWAL_DURATIONS,
  RENEWAL_ESCALATION_MODES,
  RENEWAL_ESCALATION_MODE_LABELS,
  type RenewalEscalationMode,
} from "@/lib/vo-renewal-offer";
import { partnerRenewalOffer } from "@/lib/vo-renewal-reminders";

interface Setup {
  caseNumber: string;
  clientName: string;
  status: string;
  endDate: string;
  currentFee: number;
  agreedEscalationPercentage: number;
  billing: { name: string };
  postpaid: boolean;
}

export function PartnerRenewalDialog({
  caseId, open, onClose, onDone,
}: {
  caseId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [duration, setDuration] = useState<number>(12);
  const [mode, setMode] = useState<RenewalEscalationMode>("agreed");
  const [customPct, setCustomPct] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [endConfirmed, setEndConfirmed] = useState(false);
  const [today, setToday] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSetup(null);
    setCustomPct("");
    setReason("");
    setNote("");
    setEndConfirmed(false);
    Promise.all([
      fetch(`/api/cases/${caseId}/start-renewal`).then((r) => r.json()),
      fetch(`/api/cases/${caseId}/partner-renewal`).then((r) => r.json()),
    ])
      .then(([s, p]) => {
        if (s.error) { toast.error(s.error); onClose(); return; }
        setSetup(s.data as Setup);
        setToday(p?.data?.today ?? "");
        const existing = p?.data?.confirmation;
        if (existing) {
          setDuration(existing.duration_months);
          setMode(existing.escalation_mode);
        }
      })
      .catch(() => { toast.error("Could not load the case"); onClose(); })
      .finally(() => setLoading(false));
  }, [open, caseId, onClose]);

  useEffect(() => { setEndConfirmed(false); }, [duration]);

  const offer = useMemo(() => {
    if (!setup) return null;
    return partnerRenewalOffer({
      currentMonthlyRate: setup.currentFee,
      agreedEscalationPercentage: setup.agreedEscalationPercentage,
      currentEnd: setup.endDate,
      durationMonths: duration,
      mode,
      customPercentage: mode === "custom" ? Number(customPct) || 0 : null,
    });
  }, [setup, duration, mode, customPct]);

  const customInvalid = mode === "custom" && (!(Number(customPct) > 0) || reason.trim().length < 10);
  const noPartner = !!setup && !setup.postpaid;
  const noFee = !!setup && !(setup.currentFee > 0);
  const startsNow = !!offer && !!today && today >= offer.term.start;
  const canSubmit = !!offer && !noPartner && !noFee && !customInvalid && endConfirmed && note.trim().length >= 10 && !submitting;

  const handleConfirm = async () => {
    if (!offer || !setup) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/partner-renewal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          duration_months: duration,
          escalation_mode: mode,
          custom_percentage: mode === "custom" ? Number(customPct) : null,
          escalation_reason: mode === "custom" ? reason.trim() : null,
          confirm_end_date: setup.endDate,
          expected_rate: offer.newRate,
          note: note.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Could not record the confirmation"); return; }
      if (json.data.rolled) toast.success("Renewed — the new term is now its own case");
      else if (json.data.warning) toast.warning(json.data.warning);
      else toast.success(`Confirmed — the case rolls into its new term on ${formatDate(offer.term.start)}`);
      onDone();
      onClose();
    } catch {
      toast.error("Could not record the confirmation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Confirm partner renewal</DialogTitle>
          <DialogDescription>
            Records that the partner is continuing this case. No bill or payment link is raised and
            nothing is sent; the partner keeps being invoiced monthly.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {setup && offer && (
          <div className="space-y-4 text-sm">
            {(noPartner || noFee) && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-200">
                {noPartner
                  ? "This case isn't billed monthly to a postpaid partner. Use Start renewal instead."
                  : "This case has no monthly fee on record. Set its rate first."}
              </div>
            )}

            <div className="rounded-md border p-3 space-y-1">
              <p className="font-medium">{setup.clientName}</p>
              <p className="text-xs text-muted-foreground">
                {setup.caseNumber} · invoiced monthly to {setup.billing.name}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Term length</Label>
                <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RENEWAL_DURATIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>{d} months</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Escalation on the monthly fee</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as RenewalEscalationMode)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RENEWAL_ESCALATION_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m === "agreed"
                          ? `As agreed (${setup.agreedEscalationPercentage || 0}%)`
                          : RENEWAL_ESCALATION_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {mode === "custom" && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Custom escalation %</Label>
                  <Input type="number" min={0} max={100} step="0.1" value={customPct} onChange={(e) => setCustomPct(e.target.value)} className="w-32" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Reason (kept in the audit trail)</Label>
                  <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
            )}

            <div className="rounded-md border p-3 space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Monthly fee now</span><span className="tabular-nums">{formatCurrency(offer.currentRate)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Escalation</span><span className="tabular-nums">{offer.escalationPercentage}%</span></div>
              <div className="flex justify-between text-sm font-semibold"><span>Monthly fee from the new term</span><span className="tabular-nums">{formatCurrency(offer.newRate)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">New term</span><span>{formatDate(offer.term.start)} to {formatDate(offer.term.end)}</span></div>
              <p className="pt-1 text-muted-foreground">Excluding GST. The partner is invoiced the new fee with their other cases from the month the term starts.</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">How did the partner confirm?</Label>
              <Textarea rows={2} placeholder="e.g. Email from Ravi at Acme on 12 Nov agreeing to continue for 12 months" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>

            <label className="flex items-start gap-2 text-xs">
              <Checkbox checked={endConfirmed} onCheckedChange={(v) => setEndConfirmed(v === true)} className="mt-0.5" />
              <span>
                The current term ends on <strong>{formatDate(setup.endDate)}</strong> and the new term ends on{" "}
                <strong>{formatDate(offer.term.end)}</strong>.
              </span>
            </label>

            {startsNow && (
              <p className="text-xs text-amber-700">
                The new term has already begun, so confirming rolls the case over straight away.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!canSubmit}>
            {submitting ? "Saving…" : startsNow ? "Confirm and renew" : "Record confirmation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

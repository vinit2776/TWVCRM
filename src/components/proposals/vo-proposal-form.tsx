"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LocationSelector } from "@/components/shared/location-selector";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { VO_RATE_PURPOSES, VO_RATE_PURPOSE_LABELS, VO_RATE_TERM_OPTIONS, type VoRatePurpose } from "@/lib/constants";
import { formatCurrency, preventEnterSubmit } from "@/lib/utils";
import { termFee } from "@/lib/vo-proposal";
import {
  buildVoProposalBody,
  isBelowFloor,
  parseQuotedRate,
  validateVoForm,
  type VoPricingView,
} from "@/lib/vo-proposal-form";
import type { VoPricingResult } from "@/lib/vo-pricing";

interface Props {
  leadId: string;
  leadLocationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

/** Create-proposal dialog for Virtual Office quotes. The standard ProposalForm is untouched. */
export function VoProposalForm({ leadId, leadLocationId, open, onOpenChange, onSuccess }: Props) {
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState<VoRatePurpose | "">("");
  const [locationId, setLocationId] = useState<string | null>(leadLocationId || null);
  const [termMonths, setTermMonths] = useState<number | null>(null);
  const [quotedRate, setQuotedRate] = useState("");
  const [belowFloorReason, setBelowFloorReason] = useState("");
  const [view, setView] = useState<VoPricingView>({ state: "idle" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setPurpose("");
    setLocationId(leadLocationId || null);
    setTermMonths(null);
    setQuotedRate("");
    setBelowFloorReason("");
    setView({ state: "idle" });
  }, [open, leadLocationId]);

  // Live guide / floor / suggested ask / trend for the chosen purpose, location and term.
  useEffect(() => {
    if (!open || !purpose || !locationId || termMonths === null) {
      setView({ state: "idle" });
      return;
    }
    const ctrl = new AbortController();
    setView({ state: "loading" });
    const qs = new URLSearchParams({ purpose, location_id: locationId, term: String(termMonths) });
    fetch(`/api/proposals/vo-pricing-preview?${qs}`, { signal: ctrl.signal })
      .then(async (r) => ({ ok: r.ok, json: await r.json().catch(() => null) }))
      .then(({ ok, json }) => {
        if (!ok) return setView({ state: "no_rate", message: json?.error || "Could not load the rate card price" });
        if (!json?.data?.setUp) return setView({ state: "not_set_up" });
        const pricing = json.data.pricing as VoPricingResult;
        setView(pricing.ok ? { state: "ready", pricing } : { state: "no_rate", message: pricing.message });
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setView({ state: "no_rate", message: "Could not load the rate card price" });
      });
    return () => ctrl.abort();
  }, [open, purpose, locationId, termMonths]);

  const rate = parseQuotedRate(quotedRate);
  const below = isBelowFloor(view, rate);
  const values = { title, purpose, locationId, termMonths, quotedRate, belowFloorReason };
  const blocker = useMemo(
    () => validateVoForm({ title, purpose, locationId, termMonths, quotedRate, belowFloorReason }, view),
    [title, purpose, locationId, termMonths, quotedRate, belowFloorReason, view],
  );
  const annual = termMonths !== null && termMonths > 12;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const error = validateVoForm(values, view);
    if (error || !purpose || termMonths === null) {
      toast.error(error || "Complete the form first");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildVoProposalBody({ ...values, purpose, termMonths }, leadId, below)),
      });
      if (res.ok) {
        toast.success(below ? "Proposal created. A manager has been asked to approve the below-floor price." : "Proposal created successfully");
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to create proposal");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const pricing = view.state === "ready" ? view.pricing : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Virtual Office Proposal</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="vo-title">Title <span className="text-destructive">*</span></Label>
              <Input id="vo-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Virtual Office - Acme Pvt Ltd" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vo-purpose">Purpose <span className="text-destructive">*</span></Label>
              <Select value={purpose} onValueChange={(v) => setPurpose(v as VoRatePurpose)}>
                <SelectTrigger id="vo-purpose"><SelectValue placeholder="Select purpose" /></SelectTrigger>
                <SelectContent>
                  {VO_RATE_PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>{VO_RATE_PURPOSE_LABELS[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Location <span className="text-destructive">*</span></Label>
              <LocationSelector value={locationId} onValueChange={setLocationId} placeholder="Select center" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vo-term">Term <span className="text-destructive">*</span></Label>
              <Select value={termMonths !== null ? String(termMonths) : ""} onValueChange={(v) => setTermMonths(parseInt(v))}>
                <SelectTrigger id="vo-term"><SelectValue placeholder="Select term" /></SelectTrigger>
                <SelectContent>
                  {VO_RATE_TERM_OPTIONS.map((m) => (
                    <SelectItem key={m} value={String(m)}>{m} months</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Rate card guidance */}
          <div className="border rounded-lg p-4 space-y-2 bg-muted/30">
            <Label className="text-sm font-semibold">Rate card</Label>
            {view.state === "idle" && <p className="text-xs text-muted-foreground">Choose purpose, location and term to see the guide price.</p>}
            {view.state === "loading" && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading rate card price…</p>
            )}
            {view.state === "not_set_up" && <p className="text-xs text-muted-foreground">Rate cards are not set up yet, so there is no guide price. You can still enter a price.</p>}
            {view.state === "no_rate" && (
              <p className="text-xs text-destructive flex items-start gap-1.5"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />{view.message}</p>
            )}
            {pricing && (
              <>
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Guide{annual ? " (per year)" : ""}</p>
                    <p className="font-semibold">{formatCurrency(pricing.guide)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Floor{annual ? " (per year)" : ""}</p>
                    <p className="font-semibold">{pricing.floor !== null ? formatCurrency(pricing.floor) : "None set"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Suggested ask</p>
                    <p className="font-semibold">{formatCurrency(pricing.suggestedAsk)}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {pricing.trend && pricing.trend.won > 0
                    ? `Last 180 days at this location (both purposes): ${pricing.trend.won} won${pricing.trend.avgWon !== null ? `, average ${formatCurrency(pricing.trend.avgWon)}` : ""}${pricing.trend.winRate !== null ? `, ${Math.round(pricing.trend.winRate)}% win rate` : ""}.`
                    : "No recent won quotes at this location to compare with."}
                  {" "}The guide is guidance, not a cap.
                </p>
              </>
            )}
          </div>

          {/* Quote */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="vo-quoted">
                Quoted price{annual ? " (per year)" : ""}, pre-GST <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                <Input id="vo-quoted" type="number" min="0" step="1" className="pl-6" value={quotedRate} onChange={(e) => setQuotedRate(e.target.value)} />
              </div>
              {annual && rate !== null && termMonths !== null && (
                <p className="text-xs text-muted-foreground">Whole-term fee, paid up front: {formatCurrency(termFee(rate, termMonths))}</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground self-end pb-2">No security deposit applies to Virtual Office proposals.</p>
          </div>

          {below && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
              <p className="text-sm text-amber-900 flex items-start gap-1.5">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                This price is below the floor ({pricing?.floor != null ? formatCurrency(pricing.floor) : ""}). The proposal is saved as a draft and a manager must approve it before it can be sent.
              </p>
              <Label htmlFor="vo-reason" className="text-xs text-amber-900">Reason for the discount <span className="text-destructive">*</span></Label>
              <Textarea id="vo-reason" rows={2} value={belowFloorReason} onChange={(e) => setBelowFloorReason(e.target.value)} placeholder="Why should this go below the floor?" />
            </div>
          )}

          {blocker && title.trim() && purpose && locationId && termMonths !== null && (
            <p className="text-xs text-destructive">{blocker}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting || blocker !== null}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Proposal
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

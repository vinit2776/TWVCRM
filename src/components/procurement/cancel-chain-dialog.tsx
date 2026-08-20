"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShoppingCart, PackageMinus, Banknote, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type CancellationOutcome = "revoked" | "cancelled";

type CancellationBlocker = { entity: string; reason: string };

type CancellationEffect = {
  kind: "bill_voided" | "po_cancelled" | "stock_reversed" | "advance_recovery" | "mr_status";
  label: string;
  detail?: string;
};

type CancellationImpact = {
  blockers: CancellationBlocker[];
  effects: CancellationEffect[];
  requires_admin: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Purchase request id — the only root this dialog currently supports. */
  requestId: string;
  /** Display number, e.g. "MR-00123" — shown throughout and used for type-to-confirm. */
  requestNumber: string;
  outcome: CancellationOutcome;
  onSuccess: () => void;
};

/** Group heading + icon per effect kind — new kinds the API adds later fall back to a generic group instead of being silently dropped. */
const EFFECT_GROUPS: Record<CancellationEffect["kind"], { heading: string; icon: typeof ShoppingCart; tone: string }> = {
  po_cancelled: {
    heading: "Purchase orders that will be cancelled",
    icon: ShoppingCart,
    tone: "border-red-200 bg-red-50",
  },
  bill_voided: {
    heading: "Vendor bills that will be voided",
    icon: FileText,
    tone: "border-amber-200 bg-amber-50",
  },
  stock_reversed: {
    heading: "Stock that will be reversed",
    icon: PackageMinus,
    tone: "border-amber-200 bg-amber-50",
  },
  advance_recovery: {
    heading: "Advances that will be marked recovery-due",
    icon: Banknote,
    tone: "border-amber-200 bg-amber-50",
  },
  mr_status: {
    heading: "Material request status",
    icon: FileText,
    tone: "border-slate-200 bg-slate-50",
  },
};

const GROUP_ORDER: CancellationEffect["kind"][] = [
  "po_cancelled",
  "bill_voided",
  "stock_reversed",
  "advance_recovery",
  "mr_status",
];

function groupEffects(effects: CancellationEffect[]) {
  const byKind = new Map<CancellationEffect["kind"], CancellationEffect[]>();
  for (const effect of effects) {
    const list = byKind.get(effect.kind) ?? [];
    list.push(effect);
    byKind.set(effect.kind, list);
  }
  // Known kinds first, in a fixed sensible order, then anything unexpected the API adds later.
  const orderedKinds = [
    ...GROUP_ORDER.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !GROUP_ORDER.includes(k)),
  ];
  return orderedKinds.map((kind) => ({ kind, items: byKind.get(kind)! }));
}

export function CancelChainDialog({ open, onOpenChange, requestId, requestNumber, outcome, onSuccess }: Props) {
  const [loading, setLoading] = useState(true);
  const [impact, setImpact] = useState<CancellationImpact | null>(null);
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitBlockers, setSubmitBlockers] = useState<CancellationBlocker[] | null>(null);

  const isTerminal = outcome === "cancelled";

  // Reset everything on each open so a stale impact from a previous open is never shown.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setImpact(null);
    setReason("");
    setConfirmText("");
    setSubmitError(null);
    setSubmitBlockers(null);

    let cancelled = false;
    fetch(`/api/procurement/requests/${requestId}/cancellation-impact?outcome=${outcome}`)
      .then((r) => r.json())
      .then((json: CancellationImpact | { error: string }) => {
        if (cancelled) return;
        if ("error" in json) {
          toast.error(json.error || "Failed to load cancellation impact");
          onOpenChange(false);
          return;
        }
        setImpact(json);
      })
      .catch(() => {
        if (!cancelled) {
          toast.error("Failed to load cancellation impact");
          onOpenChange(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestId, outcome]);

  const hasBlockers = (impact?.blockers.length ?? 0) > 0;
  const reasonMet = reason.trim().length >= 10;
  const confirmTextMet = !isTerminal || confirmText.trim() === requestNumber;
  const canConfirm = !hasBlockers && reasonMet && confirmTextMet && !submitting && !loading;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitBlockers(null);
    try {
      const res = await fetch(`/api/procurement/requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: isTerminal ? "cancel" : "revoke_approval",
          reason: reason.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSubmitError(json.error || "Action failed");
        if (Array.isArray(json.blockers)) setSubmitBlockers(json.blockers);
        return;
      }
      toast.success(
        isTerminal
          ? `${requestNumber} cancelled`
          : `Approval revoked for ${requestNumber}`
      );
      onSuccess();
      onOpenChange(false);
    } catch {
      setSubmitError("Action failed — check your connection and try again");
    } finally {
      setSubmitting(false);
    }
  };

  const groups = impact ? groupEffects(impact.effects) : [];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isTerminal ? "Cancel Material Request" : "Revoke Approval"} — {requestNumber}
          </DialogTitle>
          <DialogDescription>
            {isTerminal
              ? "This ends the material request permanently. Any linked purchase orders, vendor bills, stock receipts, and advances will be unwound along with it."
              : "This returns the material request to Pending Approval so it can be corrected and re-approved. Any linked purchase orders, vendor bills, stock receipts, and advances will be unwound along with it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking impact…
            </div>
          )}

          {!loading && impact && hasBlockers && (
            <div className="space-y-2">
              <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                <p className="text-sm text-red-800 font-medium">
                  This cannot proceed until the following {impact.blockers.length === 1 ? "issue is" : "issues are"} resolved:
                </p>
              </div>
              <ul className="space-y-1.5">
                {impact.blockers.map((b, i) => (
                  <li key={`${b.entity}-${i}`} className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-sm">
                    <p className="font-medium text-red-900">{b.entity}</p>
                    <p className="text-red-800">{b.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!loading && impact && !hasBlockers && (
            <div className="space-y-3">
              {groups.length === 0 && (
                <p className="text-sm text-muted-foreground">No downstream records will be affected.</p>
              )}
              {groups.map(({ kind, items }) => {
                const meta = EFFECT_GROUPS[kind] ?? {
                  heading: "Other effects",
                  icon: FileText,
                  tone: "border-slate-200 bg-slate-50",
                };
                const Icon = meta.icon;
                return (
                  <div key={kind} className={`rounded-md border px-3 py-2 ${meta.tone}`}>
                    <p className="text-sm font-semibold flex items-center gap-1.5 mb-1.5">
                      <Icon className="h-4 w-4 shrink-0" /> {meta.heading}
                    </p>
                    <ul className="space-y-1">
                      {items.map((effect, i) => (
                        <li key={`${kind}-${i}`} className="text-sm">
                          <span className="font-medium">{effect.label}</span>
                          {effect.detail && (
                            <span className="text-muted-foreground"> — {effect.detail}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}

              <div className="space-y-1.5">
                <Label>Reason <span className="text-red-500">*</span></Label>
                <Textarea
                  placeholder={isTerminal
                    ? "Explain why this material request is being cancelled…"
                    : "Explain why this approval is being revoked…"}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                />
                <p className={`text-xs ${reasonMet ? "text-green-700" : "text-muted-foreground"}`}>
                  {reason.trim().length}/10 characters minimum
                </p>
              </div>

              {isTerminal && (
                <div className="space-y-1.5">
                  <Label>
                    Type <span className="font-mono font-semibold">{requestNumber}</span> to confirm
                    <span className="text-red-500"> *</span>
                  </Label>
                  <Input
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={requestNumber}
                  />
                </div>
              )}
            </div>
          )}

          {submitError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 space-y-1.5">
              <p className="text-sm text-red-800">{submitError}</p>
              {submitBlockers && submitBlockers.length > 0 && (
                <ul className="space-y-1">
                  {submitBlockers.map((b, i) => (
                    <li key={`${b.entity}-${i}`} className="text-sm text-red-800">
                      <span className="font-medium">{b.entity}:</span> {b.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Keep Request
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {isTerminal ? "Cancel material request & chain" : "Revoke approval & unwind chain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

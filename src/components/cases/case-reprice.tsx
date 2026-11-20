"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rateCardPurposeFor } from "@/lib/vo-pricing";
import { voCaseRepriceBlockedReason } from "@/lib/vo-case-reprice";

/** Re-price a VO case against the current rate card. Offered only while the case can still change price. */
export function CaseReprice({
  caseId, status, purpose, isAggregator, hasLiveInvoice, agreementStatuses, canEdit, onChanged,
}: {
  caseId: string;
  status: string;
  purpose: string | null;
  isAggregator: boolean;
  /** The case page already loads only the non-voided invoice. */
  hasLiveInvoice: boolean;
  agreementStatuses: string[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);

  const blocked = voCaseRepriceBlockedReason({
    status,
    hasLiveInvoice,
    agreementStatuses,
    cardPurpose: rateCardPurposeFor(purpose),
  });
  if (!canEdit || blocked) return null;

  const rateNum = rate.trim() === "" ? undefined : Number(rate);
  const rateValid = rateNum === undefined || (Number.isFinite(rateNum) && rateNum > 0);

  async function apply() {
    setSaving(true);
    const res = await fetch(`/api/cases/${caseId}/reprice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rateNum === undefined ? {} : { quoted_rate: rateNum }),
    });
    setSaving(false);
    if (!res.ok) return toast.error((await res.json().catch(() => ({}))).error ?? "Could not re-price");
    toast.success("Case re-priced against the current rate card");
    setOpen(false);
    setRate("");
    onChanged();
  }

  return (
    <div className="mt-4 space-y-2 rounded-md border p-3 text-sm">
      {!open ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Re-price against current card</Button>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {isAggregator
              ? "Refreshes the saved price check against this aggregator's current card. Leave the rate blank to keep the current rate."
              : "Sets the rate from today's guide. Leave blank to use the guide, or type another rate."}{" "}
            Nothing is sent or invoiced.
          </p>
          <Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Rate" className="max-w-xs" />
          <div className="flex gap-2">
            <Button size="sm" onClick={apply} disabled={saving || !rateValid}>Apply new price</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          </div>
        </>
      )}
    </div>
  );
}

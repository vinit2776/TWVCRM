"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/utils";
import { PRICE_CLASS_LABELS, type PriceClass } from "@/lib/vo-pricing";

interface PricingData {
  setUp: boolean;
  pricing: {
    ok: true;
    guide: number;
    floor: number | null;
    termGuide: number;
    termFloor: number | null;
    termMonths: number;
    suggestedAsk: number;
    trend: { won: number; avgWon: number | null; winRate: number | null } | null;
    card: { version: number | null; how: "exact" | "any" };
    quote: { rate: number; termFee: number; classification: PriceClass; requiresApproval: boolean } | null;
  } | null;
  snapshot: { requires_approval?: boolean } | null;
  approval: { id: string; status: string; rejection_reason: string | null } | null;
  blocked_reason: string | null;
}

const CLASS_COLORS: Record<PriceClass, string> = {
  below_floor: "bg-red-100 text-red-800",
  between: "bg-amber-100 text-amber-800",
  at_or_above_guide: "bg-green-100 text-green-800",
};

/** Guide, floor and win trend for a VO proposal (read-only for reps) and its below-floor approval state. */
export function VoPricingPanel({ proposalId, canRequest, onChanged }: { proposalId: string; canRequest: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<PricingData | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/proposals/${proposalId}/vo-pricing`);
    if (res.ok) setData((await res.json()).data);
  }, [proposalId]);

  useEffect(() => { load(); }, [load]);

  if (!data || !data.setUp || !data.pricing) return null;
  const p = data.pricing;
  const multiYear = p.termMonths > 12;
  const approvalStatus = data.approval?.status;
  // Blocked and not already waiting on someone: nothing is pending, so the rep may (re)request.
  const canReRequest = canRequest && !!data.snapshot?.requires_approval && !!data.blocked_reason && approvalStatus !== "pending";

  async function requestApproval() {
    setSaving(true);
    const res = await fetch(`/api/proposals/${proposalId}/vo-pricing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    setSaving(false);
    if (!res.ok) return toast.error((await res.json().catch(() => ({}))).error ?? "Could not request approval");
    toast.success("Approval requested");
    setReason("");
    await load();
    onChanged?.();
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Rate card pricing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0 text-sm">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Guide {multiYear ? "(per year)" : ""}</p>
            <p className="font-medium">{formatCurrency(p.guide)}</p>
            {multiYear && <p className="text-xs text-muted-foreground">{formatCurrency(p.termGuide)} for {p.termMonths / 12} years, paid up front</p>}
          </div>
          <div>
            <p className="text-muted-foreground">Floor {multiYear ? "(per year)" : ""}</p>
            <p className="font-medium">{p.floor === null ? "None" : formatCurrency(p.floor)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Suggested ask</p>
            <p className="font-medium">{formatCurrency(p.suggestedAsk)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Recent quotes here (all purposes)</p>
            <p className="font-medium">
              {p.trend && p.trend.winRate !== null ? `${p.trend.winRate}% won${p.trend.avgWon ? `, avg ${formatCurrency(p.trend.avgWon)}` : ""}` : "No data"}
            </p>
          </div>
        </div>

        {p.quote && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">This quote {formatCurrency(p.quote.rate)}:</span>
            <Badge className={CLASS_COLORS[p.quote.classification]}>{PRICE_CLASS_LABELS[p.quote.classification]}</Badge>
            {data.snapshot?.requires_approval && (
              <Badge variant="outline">
                {approvalStatus === "approved" ? "Approved" : approvalStatus === "pending" ? "Waiting for manager approval" : approvalStatus === "rejected" ? "Approval rejected" : "Approval needed"}
              </Badge>
            )}
          </div>
        )}
        {data.blocked_reason && <p className="text-amber-700">{data.blocked_reason}</p>}

        {canReRequest && (
          <div className="space-y-2">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this quote below the floor?" rows={2} />
            <Button size="sm" onClick={requestApproval} disabled={saving || reason.trim().length < 5}>Request approval</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Guide prices are guidance, not a cap. Only a price below the floor needs approval.</p>
      </CardContent>
    </Card>
  );
}

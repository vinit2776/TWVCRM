"use client";

/**
 * LeadCreditsCard — surfaces partial-checkout carry-forward credits on
 * the lead profile so staff can see at a glance whether a customer has
 * unredeemed time-credit at any centre.
 *
 * Active credits are highlighted; expired/exhausted/revoked are shown
 * dimmed in a "history" section that's collapsed by default.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Coins } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { BookingCredit } from "@/types";

interface ActiveCredit extends BookingCredit {
  hours_remaining: number;
}

interface Props {
  leadId: string;
}

export function LeadCreditsCard({ leadId }: Props) {
  const [active, setActive] = useState<ActiveCredit[]>([]);
  const [history, setHistory] = useState<ActiveCredit[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [activeRes, allRes] = await Promise.all([
        fetch(`/api/booking-credits?lead_id=${leadId}`),
        fetch(`/api/booking-credits?lead_id=${leadId}&include_used=true`),
      ]);
      if (cancelled) return;
      const activeJson = await activeRes.json().catch(() => ({ data: [] }));
      const allJson = await allRes.json().catch(() => ({ data: [] }));
      const activeIds = new Set((activeJson.data || []).map((c: ActiveCredit) => c.id));
      setActive(activeJson.data || []);
      setHistory((allJson.data || []).filter((c: ActiveCredit) => !activeIds.has(c.id)));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [leadId]);

  if (loading) return null;
  if (active.length === 0 && history.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Coins className="h-4 w-4 text-emerald-600" />
          Time Credits
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {active.length > 0 ? (
          active.map((c) => (
            <CreditRow key={c.id} credit={c} active />
          ))
        ) : (
          <p className="text-xs text-muted-foreground italic">No active credits.</p>
        )}

        {history.length > 0 && (
          <div className="pt-2 border-t mt-2">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showHistory ? "Hide" : "Show"} history ({history.length})
            </button>
            {showHistory && (
              <div className="mt-2 space-y-1.5 opacity-70">
                {history.map((c) => (
                  <CreditRow key={c.id} credit={c} active={false} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreditRow({ credit, active }: { credit: ActiveCredit; active: boolean }) {
  const valueLeft = credit.hours_remaining * Number(credit.hourly_rate_snapshot);
  const isExpired = new Date(credit.expires_at) <= new Date();
  return (
    <div className={`rounded-md border px-3 py-2 ${
      active ? "border-emerald-200 bg-emerald-50/50" : "border-muted bg-muted/30"
    }`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">
            {active
              ? <>{credit.hours_remaining}h available — {formatCurrency(valueLeft)}</>
              : <>{credit.hours_total}h ({credit.status})</>}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {credit.location?.name || "—"} · issued {formatDate(credit.issued_at)}
            {active && <> · expires {formatDate(credit.expires_at)}{isExpired ? " (expired)" : ""}</>}
            {credit.issued_from_booking?.booking_number && (
              <> · from {credit.issued_from_booking.booking_number}</>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

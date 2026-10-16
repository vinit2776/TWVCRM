"use client";

import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { JourneyRentChart } from "@/components/leads/value/journey-rent-chart";
import { JourneyTimeline } from "@/components/leads/value/journey-timeline";
import { LEAD_SOURCE_LABELS } from "@/lib/constants";
import {
  todayYmdIst,
  type EscalationOutcome,
  type Journey,
  type JourneyEscalationEvent,
} from "@/lib/customer-value/journey";
import { formatDate } from "@/lib/utils";

const OUTCOME_LABEL: Record<EscalationOutcome, string> = {
  accepted: "Accepted",
  reduced: "Negotiated down",
  avoided: "Avoided",
  unknown: "Ask not recorded",
};

const OUTCOME_COLOR: Record<EscalationOutcome, string> = {
  accepted: "bg-green-100 text-green-800",
  reduced: "bg-amber-100 text-amber-800",
  avoided: "bg-amber-100 text-amber-800",
  unknown: "bg-gray-100 text-gray-700",
};

/** "1 yr 7 mo", "7 mo", or "Under a month". */
function formatSpan(months: number): string {
  if (months < 1) return "Under a month";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return `${rest} mo`;
  return rest === 0 ? `${years} yr` : `${years} yr ${rest} mo`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold leading-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function pctText(v: number | null): string {
  return v === null ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}

function rentChangeText(e: JourneyEscalationEvent): string {
  if (e.rentPerSeatChangePct === null) return "—";
  const v = e.rentPerSeatChangePct;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function JourneyPanel({ leadId }: { leadId: string }) {
  const [journey, setJourney] = useState<Journey | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/journey`);
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load the journey");
      const json = (await res.json()) as { journey: Journey };
      setJourney(json.journey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the journey");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-40" />
        <Skeleton className="h-52" />
      </div>
    );
  }

  if (error || !journey) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load the journey"}</p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!journey.hasHistory) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={History}
            title="No contract history yet"
            description="The journey appears once this customer has had a contract that went live. Drafts and withdrawn contracts don't count."
          />
        </CardContent>
      </Card>
    );
  }

  const today = todayYmdIst();
  const sourceLabels: Record<string, string> = LEAD_SOURCE_LABELS;
  const sourceLabel = journey.leadSource ? (sourceLabels[journey.leadSource] ?? journey.leadSource) : "Unknown source";
  const answered = journey.escalations.filter((e) => e.outcome !== "unknown");
  const accepted = answered.filter((e) => e.outcome === "accepted").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Lead created" value={formatSpan(journey.leadAgeMonths) + " ago"} hint={`${formatDate(journey.leadCreatedAt)} · ${sourceLabel}`} />
        <Stat
          label="First contract"
          value={journey.customerSince ? formatDate(journey.customerSince) : "—"}
          hint={journey.daysToFirstContract !== null ? `${journey.daysToFirstContract} days after the enquiry` : undefined}
        />
        <Stat
          label="Customer for"
          value={journey.tenureMonths !== null ? formatSpan(journey.tenureMonths) : "—"}
          hint={`${journey.ranContractCount} contract${journey.ranContractCount === 1 ? "" : "s"}`}
        />
        <Stat
          label="Renewals"
          value={String(journey.renewalCount)}
          hint={journey.renewalsDeclined > 0 ? `${journey.renewalsDeclined} declined` : undefined}
        />
        <Stat
          label="Breaks"
          value={journey.breakCount === 0 ? "None" : String(journey.breakCount)}
          hint={journey.breakCount === 0 ? "No gap between contracts" : `Longest ${journey.longestGapDays} days`}
        />
        <Stat
          label="Extensions"
          value={journey.extension.events === 0 ? "None" : `${journey.extension.totalDays} days`}
          hint={
            journey.extension.events === 0
              ? undefined
              : `${journey.extension.latestUsedDays} of ${journey.extension.lifetimeCap} used on the latest contract`
          }
        />
        <Stat
          label="Escalation record"
          value={answered.length === 0 ? "—" : `${accepted} of ${answered.length} accepted`}
          hint={journey.escalations.length === 0 ? "No renewals yet" : undefined}
        />
        <Stat
          label="Current contract"
          value={journey.current ? journey.current.contractNumber : "None live"}
          hint={
            journey.current
              ? `Ends in ${journey.current.daysToEnd} days${
                  journey.current.renewalDraftStatus
                    ? ` · renewal ${journey.current.renewalDraftStatus.replace(/_/g, " ")}`
                    : ""
                }`
              : undefined
          }
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Contract timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <JourneyTimeline journey={journey} today={today} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Rent and escalation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <JourneyRentChart journey={journey} />

          {journey.escalations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No renewals yet, so there is no escalation to compare.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-normal">Renewal</th>
                    <th className="py-2 pr-3 font-normal">Starts</th>
                    <th className="py-2 pr-3 text-right font-normal">Asked</th>
                    <th className="py-2 pr-3 text-right font-normal">Agreed</th>
                    <th className="py-2 pr-3 text-right font-normal">Rent per seat</th>
                    <th className="py-2 font-normal">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {journey.escalations.map((e) => (
                    <tr key={e.renewalContractId} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{e.renewalContractNumber}</span>
                        <span className="block text-xs text-muted-foreground">from {e.parentContractNumber}</span>
                      </td>
                      <td className="py-2 pr-3">{formatDate(e.date)}</td>
                      <td className="py-2 pr-3 text-right">{pctText(e.askedPct)}</td>
                      <td className="py-2 pr-3 text-right">{e.waived ? "Waived" : pctText(e.agreedPct)}</td>
                      <td className="py-2 pr-3 text-right">{rentChangeText(e)}</td>
                      <td className="py-2">
                        <Badge variant="secondary" className={OUTCOME_COLOR[e.outcome]}>
                          {OUTCOME_LABEL[e.outcome]}
                        </Badge>
                        {e.approvalStatus && (
                          <span className="ml-2 text-xs text-muted-foreground">approval {e.approvalStatus}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">
                Asked is the previous contract&apos;s escalation clause. Agreed is the renewal&apos;s own escalation. Rent per
                seat is the actual change in the monthly rent divided by seats.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

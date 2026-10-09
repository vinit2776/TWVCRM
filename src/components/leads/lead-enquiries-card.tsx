"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { enquiryStateLabel, type EnquiryOutcome } from "@/lib/enquiries";

const SOURCE_LABEL: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  direct_walkin: "Walk-in",
};

interface LeadEnquiry {
  id: string;
  reference: string;
  source: string;
  is_re_enquiry: boolean;
  received_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  resolution_outcome: EnquiryOutcome | null;
  claimer: { full_name: string } | null;
  resolver: { full_name: string } | null;
}

const stateTone = (e: LeadEnquiry) =>
  e.resolved_at
    ? e.resolution_outcome === "converted"
      ? "bg-emerald-100 text-emerald-800"
      : "bg-slate-100 text-slate-600"
    : e.claimed_at
      ? "bg-blue-100 text-blue-800"
      : "bg-emerald-50 text-emerald-700 border border-emerald-200";

/** Every public-form submission this lead has made, each with its reference number.
 *  Renders nothing for leads that never came through a form. */
export function LeadEnquiriesCard({ leadId }: { leadId: string }) {
  const [rows, setRows] = useState<LeadEnquiry[]>([]);

  useEffect(() => {
    fetch(`/api/leads/${leadId}/enquiries`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setRows((json?.data as LeadEnquiry[] | undefined) ?? []))
      .catch(() => {});
  }, [leadId]);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Enquiries ({rows.length})</CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
            <span className="font-mono font-medium">{r.reference}</span>
            <span className="flex-1 text-muted-foreground">
              {SOURCE_LABEL[r.source] ?? r.source}
              {r.is_re_enquiry && " · re-enquiry"}
              {" · "}
              {formatDate(r.received_at)}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${stateTone(r)}`}>
              {enquiryStateLabel({
                claimerName: r.claimer?.full_name ?? null,
                claimedAt: r.claimed_at,
                resolvedAt: r.resolved_at,
                resolutionOutcome: r.resolution_outcome,
                resolverName: r.resolver?.full_name ?? null,
              })}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

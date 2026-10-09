"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { describeAttribution, sanitiseAttribution } from "@/lib/public-forms/attribution";

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
  attribution?: unknown;
}

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
        {rows.map((r) => {
          const campaign = describeAttribution(sanitiseAttribution(r.attribution));
          return (
            <div key={r.id} className="py-2 text-sm first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono font-medium">{r.reference}</span>
                <span className="text-muted-foreground">
                  {SOURCE_LABEL[r.source] ?? r.source}
                  {r.is_re_enquiry && " · re-enquiry"}
                  {" · "}
                  {formatDate(r.received_at)}
                </span>
              </div>
              {campaign && <p className="mt-0.5 text-xs text-muted-foreground">Campaign: {campaign}</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

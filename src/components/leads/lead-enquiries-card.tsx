"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

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
        {rows.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
            <span className="font-mono font-medium">{r.reference}</span>
            <span className="text-muted-foreground">
              {SOURCE_LABEL[r.source] ?? r.source}
              {r.is_re_enquiry && " · re-enquiry"}
              {" · "}
              {formatDate(r.received_at)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

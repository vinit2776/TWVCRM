"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, History } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { PROPOSAL_STATUS_LABELS, CONTRACT_STATUS_LABELS, LEAD_STATUS_LABELS, isContractOperational } from "@/lib/constants";
import { summariseSeenBefore, type SeenBeforeData } from "@/lib/seen-before";

/**
 * "Seen before": what the team already knows about a customer who is enquiring again, above the call
 * form. Shown only when there is something to say; a first enquiry shows nothing. A running contract
 * is called out first, because that is a member calling, not a new sales lead.
 */
export function SeenBefore({ leadId, enquiryId }: { leadId: string; enquiryId: string }) {
  const [data, setData] = useState<SeenBeforeData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/leads/${leadId}/seen-before?exclude=${enquiryId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => !cancelled && setData((json?.data as SeenBeforeData) ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [leadId, enquiryId]);

  if (!data) return null;
  const s = summariseSeenBefore(data);
  if (!s.hasHistory) return null;

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
      {s.currentCustomer && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <b>This is a current customer</b> ({data.contracts.filter((c) => isContractOperational({ status: c.status, end_date: c.end_date })).map((c) => c.contract_number).filter(Boolean).join(", ") || "active contract"}). Check whether they need support or a change to their plan before treating this as a new sales enquiry.
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 font-semibold">
        <History className="h-4 w-4" /> Seen before
        <Link href={`/leads/${leadId}/activity`} className="ml-auto text-xs font-medium text-primary hover:underline" target="_blank">
          Open the lead ↗
        </Link>
      </div>
      <ul className="space-y-1 text-muted-foreground">
        <li>
          Lead is <b className="text-foreground">{LEAD_STATUS_LABELS[data.lead.status as keyof typeof LEAD_STATUS_LABELS] ?? data.lead.status}</b>
          {data.lead.owner_name ? <> · handled by {data.lead.owner_name}</> : <> · nobody is handling it</>}
          {s.closed === "lost" && data.lead.lost_reason ? <> · lost: {data.lead.lost_reason.replace(/_/g, " ")}</> : null}
          {s.closed === "junk" && data.lead.junk_reason ? <> · junk: {data.lead.junk_reason.replace(/_/g, " ")}</> : null}
        </li>
        {data.earlier.length > 0 && (
          <li>
            Earlier enquiries: {data.earlier.map((e) => `${e.reference} (${formatDate(e.received_at)})`).join(", ")}
          </li>
        )}
        {data.activities.length > 0 && (
          <li>
            Last touches: {data.activities.map((a) => `${a.subject || a.type} (${formatDate(a.created_at)})`).join(", ")}
          </li>
        )}
        {data.proposals.length > 0 && (
          <li>
            Proposals: {data.proposals.map((p) => `${p.proposal_number ?? "draft"} ${PROPOSAL_STATUS_LABELS[p.status] ?? p.status}`).join(", ")}
          </li>
        )}
        {data.contracts.length > 0 && (
          <li>
            Contracts: {data.contracts.map((c) => `${c.contract_number ?? "draft"} ${CONTRACT_STATUS_LABELS[c.status] ?? c.status}`).join(", ")}
          </li>
        )}
      </ul>
    </div>
  );
}

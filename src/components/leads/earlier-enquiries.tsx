"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { enquiryStateLabel, type EnquiryOutcome } from "@/lib/enquiries";

interface Row {
  id: string;
  reference: string;
  source: string;
  received_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  resolution_outcome: EnquiryOutcome | null;
  claimer: { full_name: string } | null;
  resolver: { full_name: string } | null;
}

/** "Earlier enquiries" toggle for a tracker card: lazily loads the customer's other enquiries
 *  with their final state, so a returning customer's history is one click away. */
export function EarlierEnquiries({ leadId, currentId }: { leadId: string; currentId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null) {
      fetch(`/api/leads/${leadId}/enquiries`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) =>
          setRows(((json?.data ?? []) as Row[]).filter((r) => r.id !== currentId))
        )
        .catch(() => setRows([]));
    }
  };

  return (
    <div className="mt-1.5">
      <button
        onClick={toggle}
        className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
      >
        Earlier enquiries
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 rounded-md bg-muted/40 px-2 py-1.5 text-[11px]">
          {rows === null && <li className="text-muted-foreground">Loading…</li>}
          {rows?.length === 0 && <li className="text-muted-foreground">No earlier enquiries.</li>}
          {rows?.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span>
                <span className="font-mono">{r.reference}</span>
                <span className="text-muted-foreground"> · {formatDate(r.received_at)}</span>
              </span>
              <span className="text-muted-foreground">
                {enquiryStateLabel({
                  claimerName: r.claimer?.full_name ?? null,
                  claimedAt: r.claimed_at,
                  resolvedAt: r.resolved_at,
                  resolutionOutcome: r.resolution_outcome,
                  resolverName: r.resolver?.full_name ?? null,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

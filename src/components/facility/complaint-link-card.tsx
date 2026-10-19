"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Complaint, TemplateStatus } from "@/components/facility/complaints-queue";
import { ComplaintReplyBox } from "@/components/facility/complaint-reply-box";

/** On a work order raised from a customer complaint: the complaint it came from, in the
 *  customer's own words. Renders nothing for an ordinary work order. */
export function ComplaintLinkCard({ issueId }: { issueId: string }) {
  const [c, setC] = useState<(Complaint & { lead?: { id: string } | null }) | null>(null);
  const [templates, setTemplates] = useState<TemplateStatus>({ received: false, update: false, resolved: false });

  const load = useCallback(() => {
    fetch(`/api/complaints?issue_id=${issueId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        setC((j?.data?.[0] as typeof c) ?? null);
        if (j?.templates) setTemplates(j.templates as TemplateStatus);
      })
      .catch(() => {});
  }, [issueId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!c) return null;
  return (
    <section className="rounded-lg border bg-card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Customer complaint</div>
      <div className="mt-0.5 text-sm font-medium">
        <span className="font-mono text-xs">{c.reference}</span> · {c.customer_name ?? "Customer"}
        {c.contract?.contract_number ? ` · ${c.contract.contract_number}` : ""}
      </div>
      <ul className="mt-1 space-y-0.5 text-sm">
        {c.messages.map((m, i) => <li key={i}>“{m.text}”</li>)}
      </ul>
      <ComplaintReplyBox
        complaintId={c.id}
        replies={c.replies ?? []}
        canSend={c.status === "qualified"}
        updateTemplateReady={templates.update}
        onSent={load}
      />
      {c.lead?.id && (
        <Link href={`/leads/${c.lead.id}`} className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline">
          Open customer →
        </Link>
      )}
    </section>
  );
}

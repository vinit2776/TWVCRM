"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CallInLeadForm } from "@/components/leads/call-in-lead-form";
import { SeenBefore } from "@/components/leads/seen-before";
import { HandOverButton } from "@/components/leads/hand-over-button";
import { useLocations } from "@/hooks/use-locations";
import { contactBackHints, contactBackPrefill, type ContactBackSource } from "@/lib/contact-back";
import { ENQUIRY_SOURCE_LABEL } from "@/lib/enquiries";
import { formatSmartDate } from "@/lib/utils";

interface EnquiryData extends ContactBackSource {
  id: string;
  reference: string;
  lead_id: string | null;
  source: string;
  received_at: string;
  resolved_at: string | null;
  message: string | null;
  needs_review?: boolean;
}

/**
 * Calling back someone who filled in a public form. The same requirement-first form as Log a call,
 * already filled from what they submitted; they confirm or correct it on the phone. Shown on its own
 * page and, behind the new Leads navigation, inside the check panel (`onDone` / `onDirtyChange`).
 */
export function ContactBackContent({
  enquiryId,
  onDone,
  onDirtyChange,
  wrapperClass = "mx-auto max-w-3xl",
}: {
  enquiryId: string;
  /** Called after the call is saved or the enquiry closed; without it the form leaves for the lead's page. */
  onDone?: (result: { leadId: string | null }) => void;
  /** Called with true once the person has typed or picked anything, and false after a save. */
  onDirtyChange?: (dirty: boolean) => void;
  wrapperClass?: string;
}) {
  const { locations, loading: locationsLoading } = useLocations();
  const [enquiry, setEnquiry] = useState<EnquiryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/enquiries/${enquiryId}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) setEnquiry(json.data as EnquiryData);
        else setError(json.error ?? "Could not load the enquiry");
      })
      .catch(() => !cancelled && setError("Could not load the enquiry"));
    return () => {
      cancelled = true;
    };
  }, [enquiryId]);

  const contactBack = useMemo(() => {
    if (!enquiry?.lead_id || locationsLoading) return null;
    return {
      enquiryId: enquiry.id,
      leadId: enquiry.lead_id,
      prefill: contactBackPrefill(enquiry, locations),
      hints: contactBackHints(enquiry),
      needsReview: !!enquiry.needs_review,
    };
  }, [enquiry, locations, locationsLoading]);

  if (error) {
    return (
      <div className={`${wrapperClass} space-y-3`}>
        <p className="text-sm text-red-600">{error}</p>
        <Link href="/leads" className="text-sm text-primary underline">Back to Leads</Link>
      </div>
    );
  }
  if (!enquiry || (enquiry.lead_id && !contactBack)) {
    return <p className={`${wrapperClass} text-sm text-muted-foreground`}>Loading…</p>;
  }
  if (!enquiry.lead_id || !contactBack) {
    return <p className={`${wrapperClass} text-sm text-muted-foreground`}>This enquiry has no lead to call back.</p>;
  }
  if (enquiry.resolved_at) {
    return (
      <div className={`${wrapperClass} space-y-3`}>
        <p className="text-sm">This enquiry ({enquiry.reference}) is already resolved.</p>
        <Link href={`/leads/${enquiry.lead_id}/activity`} className="text-sm text-primary underline">Open the lead</Link>
      </div>
    );
  }

  const name = contactBack.prefill.name || "Unknown";
  return (
    <div className={`${wrapperClass} space-y-4`}>
      <div className="rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="text-lg font-semibold">{name}</span>{" "}
            <span className="text-xs text-muted-foreground">
              {enquiry.reference} · received {formatSmartDate(enquiry.received_at)} · {ENQUIRY_SOURCE_LABEL[enquiry.source] ?? enquiry.source}
            </span>
          </div>
          <HandOverButton leadId={enquiry.lead_id} leadName={name} />
        </div>
        {enquiry.message && <p className="mt-2 text-sm text-muted-foreground">“{enquiry.message}”</p>}
      </div>
      <SeenBefore leadId={enquiry.lead_id} enquiryId={enquiry.id} />
      <CallInLeadForm contactBack={contactBack} onDone={onDone} onDirtyChange={onDirtyChange} />
    </div>
  );
}

"use client";

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

/** Tell GTM a lead was captured. `event_id` is the enquiry reference so the browser Pixel
 *  event and any server-side Conversions API event can be de-duplicated by Meta.
 *  Wrapped so a tracking failure can never affect the customer's submission. */
export function trackLead(args: { reference: string | null; source: string }): void {
  try {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: "generate_lead",
      event_id: args.reference ?? undefined,
      lead_source: args.source,
    });
  } catch {
    /* tracking must never break the form */
  }
}

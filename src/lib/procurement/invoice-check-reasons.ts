// Why the automatic invoice read did not produce figures. Shared by the extract
// route, the browser client and the card so the reason survives end to end.
export const INVOICE_CHECK_REASONS = [
  "not_configured",
  "too_large",
  "unsupported_type",
  "rate_limited",
  "service_error",
  "unreadable",
  "no_permission",
] as const;
export type InvoiceCheckReason = (typeof INVOICE_CHECK_REASONS)[number];

export const isInvoiceCheckReason = (v: unknown): v is InvoiceCheckReason =>
  typeof v === "string" && (INVOICE_CHECK_REASONS as readonly string[]).includes(v);

// Vercel rejects request bodies over ~4.5 MB before the route runs.
export const MAX_CHECK_UPLOAD_BYTES = 4 * 1024 * 1024;

export const INVOICE_CHECK_REASON_MESSAGES: Record<InvoiceCheckReason, string> = {
  not_configured: "the automatic check isn't set up",
  too_large: "the file is too large to check (limit is about 4 MB)",
  unsupported_type: "this file type can't be checked (use PDF, JPG, PNG or WebP)",
  rate_limited: "too many checks in a short time, wait a minute and upload again",
  service_error: "the reading service had a problem",
  unreadable: "no figures could be read from the file",
  no_permission: "your role can't use the automatic check",
};

export function invoiceCheckFailureMessage(reason: InvoiceCheckReason): string {
  return `Couldn't read this invoice automatically — ${INVOICE_CHECK_REASON_MESSAGES[reason]}. Enter the figures manually.`;
}

/**
 * Maps an error thrown while calling the model to a reason, by HTTP status only.
 * Never inspects the message, which could echo request content.
 */
export function reasonFromError(err: unknown): InvoiceCheckReason {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  if (status === 413) return "too_large";
  // A 400 from the model means it rejected the file itself (corrupt/oversized PDF), not our credentials.
  if (status === 400) return "unreadable";
  return "service_error";
}

/** Maps an HTTP status from the extract route (when no reason came back in the body). */
export function reasonFromHttpStatus(status: number): InvoiceCheckReason {
  if (status === 401 || status === 403) return "no_permission";
  if (status === 413) return "too_large";
  if (status === 415) return "unsupported_type";
  if (status === 429) return "rate_limited";
  return "service_error";
}

/**
 * Razorpay payment link for a GST tax invoice.
 *
 * The link's reference_id is derived from the invoice number alone, and
 * Razorpay refuses a second link with the same reference_id. So any second
 * attempt for the same invoice (a re-upload, or "Save & send" after a failed
 * email) is rejected with "payment link with given reference_id: … already
 * exists". Callers used to treat that as "no link" and write null over the link
 * already stored on the statement, which then went out in emails as "kindly
 * arrange payment" with nothing to click. This recovers the existing link
 * instead, and callers keep whatever is stored when no link could be obtained.
 */

export interface GstPaymentLink {
  id: string;
  url: string;
}

/** The reference_id for an invoice's GST payment link. */
export function gstLinkReferenceId(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}-gst`;
}

/** Razorpay's rejection of a reference_id that already has a link. */
export function isDuplicateReferenceId(status: number, body: string): boolean {
  return status === 400 && /reference_id/i.test(body) && /already exists/i.test(body);
}

// A link that can still be paid. Paid, cancelled and expired links are not
// reused: a paid one means the invoice is settled, the others would hand the
// customer a dead link.
const PAYABLE_STATUSES = new Set(["created", "partially_paid"]);

/**
 * Picks the reusable link out of Razorpay's "fetch payment links" response.
 * The amount must match (in paise) so a link raised for a different figure is
 * never reused. Anything unexpected in the shape yields null — never trust a
 * third-party response.
 */
export function pickReusableLink(payload: unknown, amountPaise: number): GstPaymentLink | null {
  if (!payload || typeof payload !== "object") return null;
  const links = (payload as { payment_links?: unknown }).payment_links;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    if (!link || typeof link !== "object") continue;
    const { id, short_url, status, amount } = link as Record<string, unknown>;
    if (typeof id !== "string" || typeof short_url !== "string") continue;
    if (typeof status !== "string" || !PAYABLE_STATUSES.has(status)) continue;
    if (amount !== amountPaise) continue;
    return { id, url: short_url };
  }
  return null;
}

/**
 * Creates the link, or recovers the existing one when Razorpay says this
 * reference_id is taken. Returns null when no usable link could be obtained;
 * the caller must then leave any stored link untouched.
 */
export async function createOrRecoverGstLink(params: {
  rzpAuth: string;
  payload: Record<string, unknown> & { reference_id: string; amount: number };
  logTag: string;
}): Promise<GstPaymentLink | null> {
  const { rzpAuth, payload, logTag } = params;
  const headers = { Authorization: `Basic ${rzpAuth}`, "Content-Type": "application/json" };

  const res = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    const data = (await res.json()) as { id: string; short_url: string };
    return { id: data.id, url: data.short_url };
  }

  const body = await res.text();
  if (!isDuplicateReferenceId(res.status, body)) {
    console.error(`[${logTag}] Razorpay link failed:`, body);
    return null;
  }

  const lookup = await fetch(
    `https://api.razorpay.com/v1/payment_links?reference_id=${encodeURIComponent(payload.reference_id)}`,
    { headers },
  );
  if (!lookup.ok) {
    console.error(`[${logTag}] Razorpay link exists but could not be fetched:`, await lookup.text());
    return null;
  }
  const recovered = pickReusableLink(await lookup.json(), payload.amount);
  if (!recovered) {
    console.error(`[${logTag}] Razorpay link exists for ${payload.reference_id} but is not payable or differs in amount`);
  }
  return recovered;
}

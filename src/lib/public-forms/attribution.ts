// Which ad / campaign a public-form submission came from.
//
// Captured in the browser from the landing URL (and the Meta cookies), then re-validated
// on the server before it is stored — the endpoint is public, so nothing the browser
// sends is trusted. Attribution is additive metadata: a form with none still submits.

export const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "fbp",
  "fbc",
  "landing_url",
  "referrer",
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
export type Attribution = Partial<Record<AttributionKey, string>>;

const MAX_VALUE_LENGTH = 500;

/** Whitelist + trim + length-cap whatever the browser sent. Never throws. */
export function sanitiseAttribution(raw: unknown): Attribution {
  if (!raw || typeof raw !== "object") return {};
  const out: Attribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim().slice(0, MAX_VALUE_LENGTH);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** One-line label for the lead card, e.g. "diwali-offer · meta / paid_social". */
export function describeAttribution(a: Attribution | null | undefined): string | null {
  if (!a) return null;
  const channel = [a.utm_source, a.utm_medium].filter(Boolean).join(" / ");
  const parts = [a.utm_campaign, channel].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  if (a.gclid || a.gbraid || a.wbraid) return "Google Ads click";
  if (a.fbclid) return "Meta Ads click";
  return null;
}

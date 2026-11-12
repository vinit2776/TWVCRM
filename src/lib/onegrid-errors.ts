// Turns OneGrid's raw API errors into something a non-technical user can act on.
// Kept free of server-only imports so the telemetry panel (a client component)
// can use it. The raw text is preserved as `detail` for whoever has to chase it
// with OneGrid ops — it can contain their internal hostnames and org ids.

export type OnegridErrorKind = "unavailable" | "auth" | "no_data" | "other";

export interface FriendlyOnegridError {
  kind: OnegridErrorKind;
  message: string;
  detail: string | null;
}

// Connection/timeout wording seen from OneGrid's own backend (e.g. its device
// registry database timing out) and from our own fetch to it.
const UNAVAILABLE_TEXT = /unreachable|timed? ?out|connecttimeout|max retries|econn|enotfound|could not reach|temporarily/i;
const AUTH_CODES = new Set(["INVALID_API_KEY", "UNAUTHORIZED", "FORBIDDEN", "API_KEY_REQUIRED"]);

export function describeOnegridError(
  input: { status?: number; code?: string; message?: string | null },
  fallback = "Couldn't load data from OneGrid."
): FriendlyOnegridError {
  const raw = input.message?.trim() || null;
  const { status, code } = input;

  if (status === 401 || status === 403 || (code && AUTH_CODES.has(code))) {
    return {
      kind: "auth",
      message: "OneGrid rejected this location's API key. Check the key under OneGrid Telemetry settings above.",
      detail: raw,
    };
  }
  if (
    (status !== undefined && status >= 502) ||
    code === "NETWORK_ERROR" ||
    (raw !== null && UNAVAILABLE_TEXT.test(raw))
  ) {
    return {
      kind: "unavailable",
      message:
        "OneGrid's service is temporarily unavailable, so live readings can't load right now. Your saved ledger data and the usage baseline below are not affected. Try Refresh again in a few minutes.",
      detail: raw,
    };
  }
  if (status === 404) {
    return { kind: "no_data", message: "OneGrid has no data for this meter yet.", detail: raw };
  }
  return { kind: "other", message: fallback, detail: raw };
}

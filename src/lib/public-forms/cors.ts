// CORS for the public enquiry endpoint, so the marketing website (a different origin from
// the CRM's form hosts) can read the reply — the reference number and validation errors.
// Only the origins listed here are echoed back; anything else gets no Allow-Origin header
// and the browser keeps blocking it, exactly as before.

const ALLOWED_ORIGINS = new Set([
  "https://www.theworkvilla.com",
  "https://theworkvilla.com", // redirects to www, but a form can still be opened from it
  "https://theworkvilla.vercel.app", // the website team's testing deployment
]);

export function allowedOrigin(origin: string | null): string | null {
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
}

/** Adds the CORS headers to `res` when the request came from an allowed origin. Always sets
 *  `Vary: Origin` so a cache never serves one origin's answer to another. */
export function withCors<T extends Response>(res: T, origin: string | null): T {
  res.headers.append("Vary", "Origin");
  const allowed = allowedOrigin(origin);
  if (allowed) {
    res.headers.set("Access-Control-Allow-Origin", allowed);
    res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type");
    res.headers.set("Access-Control-Max-Age", "86400");
  }
  return res;
}

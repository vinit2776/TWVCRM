// Cloudflare Turnstile verification for the public enquiry endpoint.
//
// Fails OPEN on purpose: a real customer's enquiry is worth more than a blocked bot, so
// anything other than Cloudflare explicitly saying "this token is invalid" lets the
// submission through. Does nothing at all until TURNSTILE_SECRET_KEY is set.

export type TurnstileResult = "disabled" | "passed" | "failed" | "missing" | "unavailable";

export async function verifyTurnstile(token: unknown, ip?: string | null): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return "disabled";
  if (typeof token !== "string" || !token) return "missing";

  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return "unavailable";
    const json = (await res.json()) as { success?: boolean };
    return json.success === true ? "passed" : "failed";
  } catch {
    return "unavailable";
  }
}

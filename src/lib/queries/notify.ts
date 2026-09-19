import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { renderQueryDigest, type QueryDigestEmailItem } from "./digest-email";

/**
 * Email side of query notifications. Server-only — kept out of types.ts /
 * audience.ts / registry.ts because those are imported by client components
 * and this pulls in the mailer.
 *
 * There is deliberately no per-event email any more — see digest.ts. Queries
 * used to email on every reply plus a chase every six hours, which piled up
 * into an inbox flood for anyone paged across several modules. Everything now
 * arrives as one digest per person per day.
 */

export function queryUrl(queryId: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  return `${base}/queries?open=${queryId}`;
}

/**
 * The one email a person gets per day about queries. Returns whether the send
 * succeeded so the cron can hold back its "already chased" stamps for anyone
 * who didn't hear — a swallowed failure here would silently skip a day's
 * reminders. Never throws.
 */
export async function emailQueryDigest(params: {
  to: string;
  items: QueryDigestEmailItem[];
}): Promise<boolean> {
  if (params.items.length === 0) return true;

  const { subject, html } = renderQueryDigest(params.items);
  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: [params.to],
      replyTo: EMAIL_REPLY_TO,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error("[query digest] send failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

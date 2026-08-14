import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

/**
 * Email side of billing-query notifications. Kept separate from
 * billing-queries.ts (which is imported by the client-side QueryThreadPanel
 * for its shared types) since this pulls in the mailer, which is server-only.
 */

function queryUrl(queryId: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  return `${base}/billing-queries?open=${queryId}`;
}

function emailHtml(params: { headline: string; statementLabel: string; message: string; url: string }) {
  return `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1a1a1a;margin:0 0 8px">${params.headline}</h2>
  <p style="margin:4px 0;color:#555"><strong>${params.statementLabel}</strong></p>
  <p style="margin:12px 0;color:#333;white-space:pre-wrap">${params.message}</p>
  <a href="${params.url}" style="display:inline-block;padding:10px 20px;background:#015E65;color:#fff;text-decoration:none;border-radius:6px;margin-top:8px">Open query</a>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0" />
  <p style="font-size:12px;color:#999">The WorkVilla — Billing Queries</p>
</div>`;
}

/**
 * Fire-and-forget email to a set of recipients about a billing query event
 * (new question or reply/resolution). Never throws — a failed email should
 * never block the in-app notification or the API response.
 */
export async function emailBillingQueryEvent(params: {
  recipients: Array<{ email: string | null }>;
  headline: string;
  statementLabel: string;
  message: string;
  queryId: string;
}) {
  const to = [...new Set(params.recipients.map((r) => r.email).filter((e): e is string => !!e))];
  if (to.length === 0) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to,
      replyTo: EMAIL_REPLY_TO,
      subject: params.headline,
      html: emailHtml({
        headline: params.headline,
        statementLabel: params.statementLabel,
        message: params.message,
        url: queryUrl(params.queryId),
      }),
    });
  } catch (err) {
    console.error("[billing-query email] send failed:", err instanceof Error ? err.message : err);
  }
}

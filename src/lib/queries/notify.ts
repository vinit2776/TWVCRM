import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

/**
 * Email side of query notifications. Server-only — kept out of types.ts /
 * audience.ts / registry.ts because those are imported by client components
 * and this pulls in the mailer.
 *
 * Generalised from the old src/lib/billing-queries-notify.ts: the headline
 * and context line are passed in rather than assumed to be about a billing
 * statement, and the deep link points at /queries.
 */

export function queryUrl(queryId: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  return `${base}/queries?open=${queryId}`;
}

/** Minimal escaping — bodies are user-typed and land inside an HTML email. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailHtml(params: { headline: string; entityLabel: string; message: string; url: string }) {
  return `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1a1a1a;margin:0 0 8px">${esc(params.headline)}</h2>
  <p style="margin:4px 0;color:#555"><strong>${esc(params.entityLabel)}</strong></p>
  <p style="margin:12px 0;color:#333;white-space:pre-wrap">${esc(params.message)}</p>
  <a href="${params.url}" style="display:inline-block;padding:10px 20px;background:#015E65;color:#fff;text-decoration:none;border-radius:6px;margin-top:8px">Open query</a>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0" />
  <p style="font-size:12px;color:#999">The WorkVilla — Queries</p>
</div>`;
}

/**
 * Fire-and-forget email about a query event. Never throws — a failed email
 * must not block the in-app notification or the API response.
 */
export async function emailQueryEvent(params: {
  recipients: Array<{ email: string | null }>;
  headline: string;
  /** One line of context: "Bluescale Analytics · TWV-C-0112 · STM-0042". */
  entityLabel: string;
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
        entityLabel: params.entityLabel,
        message: params.message,
        url: queryUrl(params.queryId),
      }),
    });
  } catch (err) {
    console.error("[query email] send failed:", err instanceof Error ? err.message : err);
  }
}

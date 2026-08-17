import nodemailer from "nodemailer";
import { Resend as ResendClient } from "resend";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Email transport using Google Workspace SMTP with Resend as fallback.
 *
 * Required env vars on Vercel:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_USER=contact@theworkvilla.com
 *   SMTP_PASS=xxxx xxxx xxxx xxxx         (Google App Password)
 *   RESEND_API_KEY=re_xxxx                 (fallback — used if SMTP fails)
 */

const smtpHost = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
const smtpPort = parseInt((process.env.SMTP_PORT || "587").trim(), 10);
const smtpUser = (process.env.SMTP_USER || "").trim();
const smtpPass = (process.env.SMTP_PASS || "").trim();

if (!smtpUser || !smtpPass) {
  console.warn("SMTP_USER or SMTP_PASS is not set — email sending will fall back to Resend.");
}

// Port 587 uses STARTTLS (requireTLS=true, secure=false).
// Port 465 uses implicit TLS (secure=true). 465 is often blocked from cloud IPs.
// We default to 587 which works reliably from Vercel/AWS.
//
// Explicit timeouts matter here: nodemailer's own defaults (connectionTimeout
// ~2min, socketTimeout ~10min) are far longer than callers' outer timeouts
// (e.g. EMAIL_TIMEOUT_MS=15s in send-proforma.ts). When Gmail SMTP is slow to
// respond from Vercel's network, sendMail() would just hang past that outer
// deadline without ever throwing — so the resend.emails.send() wrapper below
// never gets a chance to catch an SMTP failure and fall back to Resend; the
// whole operation is abandoned first. Short timeouts here make a stuck SMTP
// attempt fail fast, leaving the fallback enough of the outer budget to run.
// connectionTimeout and greetingTimeout are separate, potentially sequential
// phases (connect, then wait for greeting) — kept low enough that even their
// worst-case sum leaves several seconds of the outer 15s budget for the
// Resend fallback to actually complete.
const SMTP_CONNECTION_TIMEOUT_MS = 5_000;
const SMTP_GREETING_TIMEOUT_MS = 3_000;
const SMTP_SOCKET_TIMEOUT_MS = 5_000;

export const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  requireTLS: smtpPort === 587,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
  connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
  greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
  socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
});

// Resend SDK instance for fallback delivery
const resendClient = process.env.RESEND_API_KEY
  ? new ResendClient(process.env.RESEND_API_KEY)
  : null;

/**
 * Centralized "from" address for all outgoing emails.
 */
export const EMAIL_FROM = `The WorkVilla <${smtpUser || "contact@theworkvilla.com"}>`;

/**
 * Reply-to address for all outgoing emails.
 */
export const EMAIL_REPLY_TO = "billing@theworkvilla.com";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Record one email against the daily sent/failed counters.
 *
 * Must be awaited. supabase-js query builders are lazy thenables — the request
 * is only issued when .then() is called — so the previous
 *
 *     void client.rpc("increment_email_count", ...)
 *
 * discarded the builder without ever executing it. The counter silently stopped
 * on 2026-04-12, the day before that line was introduced, and every email since
 * went unrecorded. Awaiting also matters on Vercel: a floating promise can be
 * frozen with the function once the response returns.
 *
 * `success` means the email was ultimately delivered by *some* transport, not
 * that the first attempt worked — a message rescued by the Resend fallback is a
 * sent email, not a failed one.
 */
async function trackEmail(success: boolean) {
  try {
    const client = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await client.rpc("increment_email_count", {
      p_date: today,
      p_success: success,
    });
    if (error) console.error("[mailer] email counter update failed:", error.message);
  } catch (err) {
    // Never let telemetry fail a send.
    console.error("[mailer] email counter update failed:", err);
  }
}

// ─── Unified send interface ──────────────────────────────────────────────────

export type SendEmailParams = {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
};

export type SendEmailResult = {
  data: { id: string } | null;
  error: { message: string; name: string } | null;
};

async function sendViaSMTP(params: SendEmailParams): Promise<SendEmailResult> {
  const joinAddrs = (a?: string | string[]) =>
    Array.isArray(a) ? a.join(", ") : a;
  const mailOptions: nodemailer.SendMailOptions = {
    from: params.from,
    to: joinAddrs(params.to),
    cc: joinAddrs(params.cc),
    bcc: joinAddrs(params.bcc),
    subject: params.subject,
    html: params.html,
    replyTo: params.replyTo,
    attachments: params.attachments?.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType,
    })),
  };

  const info = await transporter.sendMail(mailOptions);
  console.log("Email sent via SMTP:", info.messageId, "to:", params.to);
  return { data: { id: info.messageId }, error: null };
}

async function sendViaResend(params: SendEmailParams): Promise<SendEmailResult> {
  if (!resendClient) {
    return { data: null, error: { message: "RESEND_API_KEY not configured", name: "resend_not_configured" } };
  }

  const toArray = Array.isArray(params.to) ? params.to : [params.to];

  // Resend requires "from" to be a verified domain — use the verified sender
  const fromAddr = "The WorkVilla <onboarding@theworkvilla.com>";

  const result = await resendClient.emails.send({
    from: fromAddr,
    to: toArray,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    html: params.html,
    replyTo: params.replyTo,
    attachments: params.attachments?.map((att) => ({
      filename: att.filename,
      content: typeof att.content === "string" ? att.content : att.content.toString("base64"),
      content_type: att.contentType,
    })),
  });

  if (result.error) {
    return { data: null, error: { message: result.error.message, name: "resend_error" } };
  }

  console.log("Email sent via Resend fallback:", result.data?.id, "to:", toArray);
  return { data: { id: result.data?.id || "resend" }, error: null };
}

/**
 * `resend` — drop-in compatible with prior usage across the codebase.
 * Tries SMTP first; falls back to Resend SDK if SMTP throws.
 */
export const resend = {
  emails: {
    send: async (params: SendEmailParams): Promise<SendEmailResult> => {
      // ── Primary: SMTP ───────────────────────────────────────────────────────
      if (smtpUser && smtpPass) {
        try {
          const result = await sendViaSMTP(params);
          await trackEmail(true);
          return result;
        } catch (smtpErr) {
          const smtpMessage = smtpErr instanceof Error ? smtpErr.message : String(smtpErr);
          console.error("SMTP failed, trying Resend fallback:", smtpMessage);

          // ── Fallback: Resend SDK ──────────────────────────────────────────
          // The counter is recorded on the outcome, not here: an email rescued
          // by this fallback was delivered, and counting it as failed would
          // make the fallback look like the thing going wrong.
          try {
            const fallbackResult = await sendViaResend(params);
            if (!fallbackResult.error) {
              console.warn("Email delivered via Resend fallback (SMTP was down)");
            }
            await trackEmail(!fallbackResult.error);
            return fallbackResult;
          } catch (resendErr) {
            const resendMessage = resendErr instanceof Error ? resendErr.message : String(resendErr);
            console.error("Resend fallback also failed:", resendMessage);
            await trackEmail(false);
            return {
              data: null,
              error: { message: `SMTP: ${smtpMessage} | Resend: ${resendMessage}`, name: "all_transports_failed" },
            };
          }
        }
      }

      // ── No SMTP configured: use Resend directly ─────────────────────────
      try {
        const result = await sendViaResend(params);
        await trackEmail(!result.error);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await trackEmail(false);
        return { data: null, error: { message, name: "resend_error" } };
      }
    },
  },
};

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
export const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  requireTLS: smtpPort === 587,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
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
export const EMAIL_REPLY_TO = "space@theworkvilla.com";

// ─── Helpers ────────────────────────────────────────────────────────────────

function trackEmail(success: boolean) {
  try {
    const client = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);
    void client.rpc("increment_email_count", { p_date: today, p_success: success });
  } catch {
    // non-fatal
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
          trackEmail(true);
          return result;
        } catch (smtpErr) {
          const smtpMessage = smtpErr instanceof Error ? smtpErr.message : String(smtpErr);
          console.error("SMTP failed, trying Resend fallback:", smtpMessage);
          trackEmail(false);

          // ── Fallback: Resend SDK ──────────────────────────────────────────
          try {
            const fallbackResult = await sendViaResend(params);
            if (!fallbackResult.error) {
              console.warn("Email delivered via Resend fallback (SMTP was down)");
            }
            return fallbackResult;
          } catch (resendErr) {
            const resendMessage = resendErr instanceof Error ? resendErr.message : String(resendErr);
            console.error("Resend fallback also failed:", resendMessage);
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
        if (result.error) trackEmail(false);
        else trackEmail(true);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trackEmail(false);
        return { data: null, error: { message, name: "resend_error" } };
      }
    },
  },
};

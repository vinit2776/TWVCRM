import nodemailer from "nodemailer";

/**
 * Email transport using Google Workspace SMTP.
 *
 * Required env vars on Vercel:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_USER=contact@theworkvilla.com      (your Google Workspace email)
 *   SMTP_PASS=xxxx xxxx xxxx xxxx           (Google App Password — NOT your login password)
 *
 * To generate an App Password:
 *   1. Go to https://myaccount.google.com/apppasswords
 *   2. Select "Mail" and "Other (Custom name)" → name it "TWV CRM"
 *   3. Copy the 16-character password and set it as SMTP_PASS
 *   4. 2-Step Verification must be enabled on the Google Workspace account
 */

const smtpHost = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
const smtpPort = parseInt((process.env.SMTP_PORT || "465").trim(), 10);
const smtpUser = (process.env.SMTP_USER || "").trim();
const smtpPass = (process.env.SMTP_PASS || "").trim();

if (!smtpUser || !smtpPass) {
  console.warn("SMTP_USER or SMTP_PASS is not set — email sending will fail.");
}

export const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465, // true for 465, false for 587
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

/**
 * Centralized "from" address for all outgoing emails.
 * MUST match the SMTP_USER (authenticated Google Workspace account)
 * otherwise Gmail will rewrite or reject the message.
 */
export const EMAIL_FROM = `The WorkVilla <${smtpUser || "contact@theworkvilla.com"}>`;

/**
 * Reply-to address for all outgoing emails.
 * Recipients who hit "Reply" will reach this inbox.
 */
export const EMAIL_REPLY_TO = "contact@theworkvilla.com";

/**
 * Drop-in replacement for the Resend SDK.
 *
 * All existing routes call: resend.emails.send({ from, to, subject, html, replyTo, attachments })
 * This wrapper translates that to nodemailer format and returns { data, error }
 * matching the Resend SDK response shape.
 */
export const resend = {
  emails: {
    send: async (params: {
      from: string;
      to: string | string[];
      subject: string;
      html: string;
      replyTo?: string;
      attachments?: Array<{
        filename: string;
        content: Buffer | string;
        contentType?: string;
      }>;
    }): Promise<{ data: { id: string } | null; error: { message: string; name: string } | null }> => {
      try {
        const mailOptions: nodemailer.SendMailOptions = {
          from: params.from,
          to: Array.isArray(params.to) ? params.to.join(", ") : params.to,
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

        return {
          data: { id: info.messageId },
          error: null,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown SMTP error";
        console.error("SMTP email error:", message);
        return {
          data: null,
          error: { message, name: "smtp_error" },
        };
      }
    },
  },
};

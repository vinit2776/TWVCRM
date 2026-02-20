import { Resend } from "resend";

if (!process.env.RESEND_API_KEY) {
  console.warn("RESEND_API_KEY is not set — email sending will fail.");
}

// Use a placeholder key during build to prevent Resend from throwing at construction time.
// Actual email sends will still fail gracefully without a real key.
// Note: .trim() is critical — env vars on Vercel can have trailing newlines
export const resend = new Resend((process.env.RESEND_API_KEY || "re_placeholder").trim());

/**
 * Centralized "from" address for all outgoing emails.
 *
 * Set RESEND_FROM_EMAIL in your env to use a verified custom domain, e.g.:
 *   RESEND_FROM_EMAIL="The WorkVilla <noreply@theworkvilla.com>"
 *
 * If not set, falls back to the Resend test address which can ONLY
 * deliver to the Resend account owner's email.
 */
export const EMAIL_FROM =
  (process.env.RESEND_FROM_EMAIL || "The WorkVilla <onboarding@resend.dev>").trim();

/**
 * Reply-to address for all outgoing emails.
 * Recipients who hit "Reply" will reach this inbox.
 */
export const EMAIL_REPLY_TO = "contact@theworkvilla.com";

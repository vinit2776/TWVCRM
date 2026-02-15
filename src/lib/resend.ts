import { Resend } from "resend";

if (!process.env.RESEND_API_KEY) {
  console.warn("RESEND_API_KEY is not set — email sending will fail.");
}

// Use a placeholder key during build to prevent Resend from throwing at construction time.
// Actual email sends will still fail gracefully without a real key.
export const resend = new Resend(process.env.RESEND_API_KEY || "re_placeholder");

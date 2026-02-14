import { Resend } from "resend";

if (!process.env.RESEND_API_KEY) {
  console.warn("RESEND_API_KEY is not set — email sending will fail.");
}

export const resend = new Resend(process.env.RESEND_API_KEY);

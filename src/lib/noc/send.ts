import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { unsafeRecipientReason } from "@/lib/noc/safe-send";

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string; blocked?: boolean };

/**
 * The one place the NOC service emails a customer. Outside real production it refuses anything but a reserved test
 * address (see safe-send.ts), so clicking Send on a staging fixture can never reach a real person.
 */
export async function sendNocEmail(
  _admin: SupabaseClient,
  p: { to: string; subject: string; html: string; attachments?: { filename: string; content: Buffer; contentType: string }[] },
): Promise<SendResult> {
  const blocked = unsafeRecipientReason(p.to);
  if (blocked) return { ok: false, error: blocked, blocked: true };
  try {
    const r = await resend.emails.send({ from: EMAIL_FROM, replyTo: EMAIL_REPLY_TO, to: [p.to], subject: p.subject, html: p.html, attachments: p.attachments, patient: true });
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true, id: r.data?.id ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The email could not be sent." };
  }
}

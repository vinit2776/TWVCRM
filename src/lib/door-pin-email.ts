/**
 * Door-access PIN email.
 *
 * Enrollment PINs used to go out as an SMS on the "TWV_OTP_Transactional" DLT
 * template, because it was the only registered template that carried a bare
 * number. The text read "Your OTP for The Work Villa is 140980. Valid for 10
 * minutes. Do not share this OTP." — which a tenant's staff reasonably took for
 * a login code they had never asked for. A DLT template cannot be reworded, so
 * until a door-PIN template is registered the PIN goes by email, where the
 * wording is ours. Do not point door PINs back at dltSms.otp(); that template is
 * for genuine one-time codes only (see /api/admin/otp).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";

export type DoorPinEmailResult =
  | { sent: true }
  | { sent: false; reason: "no_email" | "send_failed" };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type DoorPinPurpose = "enrollment" | "fallback";

/**
 * Where to record the send. Every attempt (sent, no email, failed) is written to
 * the audit trail on the contract so the People screen can show who issued the
 * PIN, to which address, when, and how long the door access is valid.
 */
export interface DoorPinRecord {
  admin: SupabaseClient;
  contractId: string;
  memberId: string;
  /** users.id of the staff member who triggered it; null for system actions. */
  performedBy: string | null;
  /** Date the member's door access runs to (the contract end), if known. */
  validUntil: string | null;
}

export async function sendDoorPinEmail(params: {
  to: string | null | undefined;
  name: string;
  pin: string;
  /**
   * enrollment: first-time fingerprint set-up (readers with a fingerprint scanner).
   * fallback: a PIN to type on the keypad instead of a card, e.g. until the card is issued
   * (card-only readers) or when the card or finger isn't working.
   */
  purpose: DoorPinPurpose;
  record?: DoorPinRecord;
}): Promise<DoorPinEmailResult> {
  const result = await deliverDoorPinEmail(params);
  const r = params.record;
  if (r) {
    await logAudit(r.admin, {
      entityType: "contract",
      entityId: r.contractId,
      action: "email_sent",
      performedBy: r.performedBy,
      changes: {
        door_pin: {
          old: null,
          new: {
            member_id: r.memberId,
            purpose: params.purpose,
            email: params.to?.trim() || null,
            sent: result.sent,
            reason: result.sent ? null : result.reason,
            valid_until: r.validUntil,
          },
        },
      },
    });
  }
  return result;
}

async function deliverDoorPinEmail(params: {
  to: string | null | undefined;
  name: string;
  pin: string;
  purpose: DoorPinPurpose;
}): Promise<DoorPinEmailResult> {
  const to = params.to?.trim();
  if (!to) return { sent: false, reason: "no_email" };

  const name = escapeHtml(params.name || "there");
  const pin = escapeHtml(params.pin);
  const enrollment = params.purpose === "enrollment";
  const label = enrollment ? "Your enrollment PIN" : "Your access PIN";
  const intro = enrollment
    ? `You have been given door access to your office at The WorkVilla. This is <strong>not a login code</strong> &mdash; it is the one-time PIN for setting up your fingerprint on the door reader.`
    : `Here is a PIN you can use to open the door at The WorkVilla if you do not have your access card yet, or it is not working. This is <strong>not a login code</strong>.`;
  const steps = enrollment
    ? `<li>Go to the door reader and type this PIN on the keypad.</li>
            <li>The reader will then ask you to scan your finger a few times.</li>
            <li>After that, your fingerprint opens the door &mdash; you will not need the PIN again.</li>`
    : `<li>Go to the door reader and type this PIN on the keypad.</li>
            <li>The door will open. Once you have your access card, use it as usual.</li>`;

  try {
    const result = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to,
      subject: "Your door access PIN — The WorkVilla",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#015E65;margin:0 0 16px;">Your door access PIN</h2>
          <p style="color:#333;font-size:14px;">Hi ${name},</p>
          <p style="color:#333;font-size:14px;">${intro}</p>
          <div style="background:#E6F4F1;border-radius:8px;padding:16px;text-align:center;margin:16px 0;">
            <p style="color:#015E65;font-size:12px;margin:0 0 8px;">${label}</p>
            <p style="color:#015E65;font-size:36px;font-weight:bold;margin:0;letter-spacing:8px;font-family:monospace;">${pin}</p>
          </div>
          <ol style="color:#333;font-size:14px;line-height:1.6;padding-left:20px;">${steps}</ol>
          <p style="color:#666;font-size:12px;">Please do not share this PIN. If you were not expecting door access, reply to this email and let us know.</p>
        </div>`,
    });
    if (result.error) {
      console.error("[door-pin-email] send failed:", result.error.message);
      return { sent: false, reason: "send_failed" };
    }
    return { sent: true };
  } catch (err) {
    console.error("[door-pin-email] send error:", err instanceof Error ? err.message : String(err));
    return { sent: false, reason: "send_failed" };
  }
}

/** Plain-words reason shown to staff when the PIN could not be emailed, with the fix. */
export function doorPinEmailProblem(reason: "no_email" | "send_failed", who: string): string {
  return reason === "no_email"
    ? `${who} has no email on record, so the PIN could not be sent. Add their email under the contract's People, then send the PIN again.`
    : `The PIN email to ${who} could not be sent. Try again in a moment.`;
}

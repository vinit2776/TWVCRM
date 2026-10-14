/**
 * Proposal follow-ups: when to nudge the customer, when to prompt the rep, and
 * when a proposal lapses. Pure functions only — the cron route does the I/O —
 * so the timing rules can be unit-tested without a database or a mailbox.
 */

export const NUDGE_1_AFTER_DAYS = 3;
export const REP_FOLLOWUP_AFTER_DAYS = 5;
export const NUDGE_2_AFTER_DAYS = 10;
/** Used only when a proposal has no valid_until of its own. */
export const DEFAULT_VALIDITY_DAYS = 14;
/**
 * Proposals sent longer ago than this are never nudged. Without it, turning
 * the feature on would email every long-dead proposal in the system at once.
 */
export const NUDGE_BACKLOG_CUTOFF_DAYS = 30;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface FollowupProposal {
  status: string;
  sent_at: string | null;
  valid_until: string | null;
  payment_status?: string | null;
  deposit_payment_status?: string | null;
  nudge_1_sent_at: string | null;
  nudge_2_sent_at: string | null;
  rep_followup_notified_at: string | null;
}

export interface FollowupActions {
  expire: boolean;
  nudge1: boolean;
  nudge2: boolean;
  notifyRep: boolean;
}

/** Calendar date (YYYY-MM-DD) of an instant, as seen in IST. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round(
    (new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / DAY_MS
  );
}

/** Last day the proposal is open (valid_until, else sent date + 14 days). */
export function effectiveExpiryDate(p: Pick<FollowupProposal, "sent_at" | "valid_until">): string | null {
  if (p.valid_until) return p.valid_until.slice(0, 10);
  if (!p.sent_at) return null;
  return istDate(new Date(new Date(p.sent_at).getTime() + DEFAULT_VALIDITY_DAYS * DAY_MS));
}

export function computeFollowupActions(p: FollowupProposal, now: Date): FollowupActions {
  const none: FollowupActions = { expire: false, nudge1: false, nudge2: false, notifyRep: false };

  // Only proposals still waiting on the customer, with nothing paid yet.
  if (p.status !== "sent" && p.status !== "viewed") return none;
  if (p.payment_status === "paid" || p.deposit_payment_status === "paid") return none;
  if (!p.sent_at) return none;

  const today = istDate(now);
  const expiry = effectiveExpiryDate(p);
  if (expiry && today > expiry) return { ...none, expire: true };

  const age = daysBetween(istDate(new Date(p.sent_at)), today);
  if (age > NUDGE_BACKLOG_CUTOFF_DAYS) return none;

  return {
    expire: false,
    // Nudge 1 is skipped once nudge 2 is due, so a missed run never sends both together.
    nudge1: !p.nudge_1_sent_at && age >= NUDGE_1_AFTER_DAYS && age < NUDGE_2_AFTER_DAYS,
    nudge2: !p.nudge_2_sent_at && age >= NUDGE_2_AFTER_DAYS,
    notifyRep: !p.rep_followup_notified_at && age >= REP_FOLLOWUP_AFTER_DAYS,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatLongDate(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC", day: "numeric", month: "long", year: "numeric",
  });
}

export interface NudgeEmailInput {
  nudge: 1 | 2;
  customerFirstName: string;
  proposalNumber: string;
  title: string;
  locationName: string | null;
  sentDate: string;      // YYYY-MM-DD
  validUntil: string | null;  // YYYY-MM-DD
  daysLeft: number | null;
  repName: string;
  repEmail: string | null;
  repPhone: string | null;
  trackingUrl: string;
}

export function buildNudgeEmail(i: NudgeEmailInput): { subject: string; html: string } {
  const place = i.locationName ? ` at ${esc(i.locationName)}` : "";
  const subject = i.nudge === 1
    ? `Your workspace proposal at The WorkVilla (${i.proposalNumber})`
    : i.daysLeft !== null && i.daysLeft >= 0
      ? `Your proposal expires in ${i.daysLeft} day${i.daysLeft === 1 ? "" : "s"} (${i.proposalNumber})`
      : `Your workspace proposal at The WorkVilla (${i.proposalNumber})`;

  const intro = i.nudge === 1
    ? `We shared proposal <strong>${esc(i.proposalNumber)}</strong> (${esc(i.title)})${place} on ${esc(formatLongDate(i.sentDate))}.`
    : `A quick reminder about proposal <strong>${esc(i.proposalNumber)}</strong> (${esc(i.title)})${place}.`;
  const validity = i.validUntil
    ? `It is valid until <strong>${esc(formatLongDate(i.validUntil))}</strong>.`
    : "";
  const contact = [
    i.repEmail ? `reply to this email` : null,
    i.repPhone ? `call me on <strong>${esc(i.repPhone)}</strong>` : null,
  ].filter(Boolean).join(" or ") || "reply to this email";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #015E65; padding: 20px 32px;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: bold;">The WorkVilla</h1>
      </div>
      <div style="padding: 28px 32px;">
        <p style="color: #1a1b1e; font-size: 15px;">Hi ${esc(i.customerFirstName || "there")},</p>
        <p style="color: #333; font-size: 14px; line-height: 1.6;">${intro} ${validity}</p>
        <p style="color: #333; font-size: 14px; line-height: 1.6;">Happy to answer questions, adjust seats, or arrange another tour. Just ${contact}.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${esc(i.trackingUrl)}" style="display:inline-block;background:#015E65;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px;">Review your proposal →</a>
        </div>
        <p style="color: #333; font-size: 14px; margin-top: 20px;">Warm regards,<br/><strong>${esc(i.repName)}</strong><br/>The WorkVilla</p>
      </div>
    </div>`;
  return { subject, html };
}

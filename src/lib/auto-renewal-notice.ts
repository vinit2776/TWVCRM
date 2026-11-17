/**
 * Auto-renewal customer notices (part 4a): drafting, rendering and the rules for
 * when a notice is due or late. Pure functions: no database, no sending.
 *
 * The notice is a written statement of the new rent under clauses 18 and 19 of the
 * signed agreement. Email is the valid delivery method; nothing else is sent.
 */
import { escapeHtml } from "@/lib/auto-renewal-plan";

export const NOTICE_MODE_SETTING = "auto_renew_notice_mode";

export const NOTICE_KINDS = ["notice", "confirmation"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const NOTICE_STATUSES = ["draft", "approved", "sending", "sent", "failed", "cancelled"] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const NOTICE_KIND_LABELS: Record<NoticeKind, string> = {
  notice: "Renewal notice",
  confirmation: "Rate confirmation",
};

export const NOTICE_STATUS_LABELS: Record<NoticeStatus, string> = {
  draft: "Draft, needs approval",
  approved: "Approved, goes out on its day",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed to send",
  cancelled: "Cancelled",
};

export type NoticeMode = "off" | "dry_run" | "live";

/** Anything unrecognised reads as dry_run, never live. */
export function parseNoticeMode(value: string | null | undefined): NoticeMode {
  return value === "off" || value === "live" ? value : "dry_run";
}

/** Roles who may review, edit, approve and send a notice. */
export { AUTO_RENEW_MANAGE_ROLES as NOTICE_MANAGE_ROLES } from "@/lib/auto-renewal";

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** The customer's address plus their billing addresses, the way invoices are addressed. Deduplicated, valid only. */
export function noticeRecipients(lead: { email?: string | null; billing_emails?: string[] | null } | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [lead?.email, ...(lead?.billing_emails ?? [])]) {
    const email = (raw ?? "").trim();
    if (!email || !isValidEmail(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * Staging holds real email keys, so a send from anywhere that is not the
 * production database may only reach reserved fake addresses (@example.com).
 * Anything else is blocked, not redirected.
 */
export function splitRecipientsForEnvironment(
  recipients: string[],
  isProduction: boolean,
): { allowed: string[]; blocked: string[] } {
  if (isProduction) return { allowed: recipients, blocked: [] };
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const r of recipients) (/@example\.com$/i.test(r.trim()) ? allowed : blocked).push(r);
  return { allowed, blocked };
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export interface NoticeDraftInput {
  kind: NoticeKind;
  customer: string;
  contractNumber: string;
  location: string | null;
  /** End date of the term being renewed, YYYY-MM-DD. */
  endDate: string;
  /** First day of the renewed term, YYYY-MM-DD (the day after the end date). */
  renewalStart: string;
  termMonths: number;
  currentRent: number;
  newRent: number;
  escalationPercentage: number;
  /** True when the rate was agreed with the customer for this term only. */
  negotiated: boolean;
  /** Last day the customer can serve notice of non-renewal, YYYY-MM-DD. */
  noticeDeadline: string;
  /** When the rate notice went out, for the reminder. */
  notifiedOn?: string | null;
  senderName?: string;
}

export function formatInr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

export function longDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC", day: "numeric", month: "long", year: "numeric",
  });
}

export function buildNoticeDraft(i: NoticeDraftInput): { subject: string; body: string } {
  const sender = i.senderName?.trim() || "The WorkVilla team";
  const where = i.location ? ` at ${i.location}` : "";
  const start = longDate(i.renewalStart);

  if (i.kind === "confirmation") {
    const notified = i.notifiedOn ? `, as notified on ${longDate(i.notifiedOn)}` : "";
    return {
      subject: `Reminder: your agreement renews on ${start}`,
      body: [
        `Dear ${i.customer},`,
        `A reminder that your agreement (${i.contractNumber})${where} renews on ${start}. The rent from that date is ${formatInr(i.newRent)} per month (plus GST as applicable)${notified}. No action is needed from you.`,
        `Regards,\n${sender}\nThe WorkVilla`,
      ].join("\n\n"),
    };
  }

  const rateSentence = i.negotiated
    ? `Following our discussion, we have agreed a rent of ${formatInr(i.newRent)} per month for this term. This applies to this renewal term only.`
    : `As set out in clauses 18 and 19 of your signed agreement, it renews automatically for a further ${i.termMonths} months from ${start}, with the rent increasing by ${i.escalationPercentage}%.`;

  return {
    subject: `Your agreement at The WorkVilla renews on ${start}`,
    body: [
      `Dear ${i.customer},`,
      `Your agreement (${i.contractNumber})${where} ends on ${longDate(i.endDate)}.`,
      i.negotiated
        ? `${rateSentence} Your agreement renews for a further ${i.termMonths} months from ${start}.`
        : rateSentence,
      `- Current monthly rent: ${formatInr(i.currentRent)}\n- Monthly rent from ${start}: ${formatInr(i.newRent)} (plus GST as applicable)\n- All other terms stay the same.`,
      `If you do not wish to renew, please tell us in writing by ${longDate(i.noticeDeadline)}. If you would like to talk about the renewal, reply to this email or call +91 97910 97900.`,
      `Regards,\n${sender}\nThe WorkVilla`,
    ].join("\n\n"),
  };
}

/** Plain-text body to the email HTML: paragraphs, "- " bullet lines, the house header and footer. */
export function renderNoticeHtml(body: string): string {
  const blocks = body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const html = blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => l.startsWith("- "))) {
        return `<ul style="color:#333;font-size:14px;padding-left:20px;margin:12px 0;">${lines
          .map((l) => `<li style="margin:4px 0;">${escapeHtml(l.slice(2))}</li>`)
          .join("")}</ul>`;
      }
      return `<p style="color:#333;font-size:14px;margin:12px 0;">${lines.map(escapeHtml).join("<br/>")}</p>`;
    })
    .join("");
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #015E65; padding: 24px 32px;">
        <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
      </div>
      <div style="padding: 24px 32px;">${html}
        <p style="color: #666; font-size: 12px; margin-top: 16px;">For any queries, write to us at <a href="mailto:contact@theworkvilla.com" style="color: #015E65;">contact@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
      </div>
      <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
        <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 10px;">www.theworkvilla.com</p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// When is a notice due, and is it late?
// ---------------------------------------------------------------------------

export interface NoticeTimingInput {
  kind: NoticeKind;
  status: NoticeStatus | null;
  sendOn: string;
}

export type NoticeAttention =
  | "none"
  /** Not approved yet but its day is still ahead. */
  | "needs_approval"
  /** Approved; the job sends it on its day. */
  | "scheduled"
  /** Its day has passed and it has not gone out: staff send it by hand. */
  | "late"
  | "sent"
  | "failed";

/** What staff should see on the contract for a notice, given today's date. */
export function noticeAttention(today: string, n: NoticeTimingInput | null): NoticeAttention {
  if (!n || n.status === "cancelled") return "none";
  if (n.status === "sent") return "sent";
  if (n.status === "failed") return "failed";
  if (today > n.sendOn) return "late";
  if (n.status === "approved" || n.status === "sending") return "scheduled";
  return "needs_approval";
}

/** Whether the daily job should send this notice now: approved, and its day has come. */
export function isDueToSend(today: string, n: { status: NoticeStatus; sendOn: string }): boolean {
  return n.status === "approved" && n.sendOn <= today;
}

/**
 * Which notice kinds the daily job should prepare today.
 *
 * The rate notice is drafted from the draft day. The reminder is drafted once the
 * rate notice has actually gone out (it restates the locked rate), and only when the
 * schedule has a reminder at all. Nothing is drafted once the term has ended, or for
 * a contract that is held for a person.
 */
export function kindsToPrepare(
  today: string,
  schedule: { draftOn: string; confirmationOn: string | null },
  endDate: string,
  held: boolean,
  have: NoticeKind[],
  noticeSent: boolean,
): NoticeKind[] {
  if (held || today > endDate) return [];
  const out: NoticeKind[] = [];
  if (today >= schedule.draftOn && !have.includes("notice")) out.push("notice");
  if (schedule.confirmationOn && noticeSent && !have.includes("confirmation")) out.push("confirmation");
  return out;
}

export function sendDayFor(
  kind: NoticeKind,
  schedule: { noticeOn: string; confirmationOn: string | null },
): string {
  return kind === "notice" ? schedule.noticeOn : (schedule.confirmationOn ?? schedule.noticeOn);
}

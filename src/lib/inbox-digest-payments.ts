import { formatCurrency } from "@/lib/utils";
import { STATEMENT_PAYMENT_MODE_LABELS } from "@/lib/constants";

/**
 * The "Payments to verify" block of the daily Tally Inbox digest.
 *
 * Pure so the email can be checked without sending one. Capped at
 * MAX_LISTED: the digest is a nudge to open the inbox, not a second copy of it.
 */

export const MAX_LISTED = 5;

export interface PendingPaymentReport {
  customer: string;
  reference: string | null;
  amount: number;
  paymentMode: string;
  reportedBy: string;
  /** ISO timestamp the report was raised. */
  createdAt: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export function waitingDays(createdAt: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(createdAt)) / 86_400_000));
}

function waitingText(days: number): string {
  return days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

/** Oldest first — the claim most at risk of going cold leads the list. */
export function sortOldestFirst(reports: PendingPaymentReport[]): PendingPaymentReport[] {
  return [...reports].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function renderPaymentsToVerifyHtml(
  reports: PendingPaymentReport[],
  appUrl: string,
  now: number,
): string {
  if (reports.length === 0) return "";
  const sorted = sortOldestFirst(reports);
  const shown = sorted.slice(0, MAX_LISTED);
  const hidden = sorted.length - shown.length;

  const items = shown
    .map((r) => {
      const days = waitingDays(r.createdAt, now);
      const mode = STATEMENT_PAYMENT_MODE_LABELS[r.paymentMode] ?? r.paymentMode;
      const overdue = days >= 2;
      return `
        <tr style="border-top:1px solid #eee;">
          <td style="padding:8px 12px 8px 0;">${escapeHtml(r.customer)}${r.reference ? `<br/><span style="color:#666;font-size:12px;">${escapeHtml(r.reference)}</span>` : ""}</td>
          <td style="padding:8px 12px;font-variant-numeric:tabular-nums;">${formatCurrency(r.amount)}<br/><span style="color:#666;font-size:12px;">${escapeHtml(mode)}</span></td>
          <td style="padding:8px 12px;font-size:13px;">${escapeHtml(r.reportedBy)}</td>
          <td style="padding:8px 12px;text-align:right;${overdue ? "color:#a32d2d;font-weight:500;" : "color:#666;"}">${waitingText(days)}</td>
        </tr>`;
    })
    .join("");

  return `
    <h3 style="margin:24px 0 4px;font-size:15px;font-weight:500;">Payments to verify (${reports.length})</h3>
    <p style="margin:0 0 8px;color:#666;font-size:13px;">Reported by the team, waiting on a bank check.</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px;border-top:1px solid #ddd;">
      <tbody>${items}</tbody>
    </table>
    ${hidden > 0 ? `<p style="margin:6px 0 0;color:#666;font-size:12px;">+ ${hidden} more</p>` : ""}
    <p style="margin:12px 0 0;"><a href="${appUrl}/accounting/inbox" style="color:#111;">Open the To verify tab</a></p>`;
}

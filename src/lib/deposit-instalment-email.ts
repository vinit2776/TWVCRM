import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { escapeHtml } from "@/lib/html";
import { depositPosition, type InstalmentFigures } from "@/lib/deposit-instalments";

/**
 * Customer emails for a deposit collected in parts. Every message carries the
 * same four lines so the customer never has to work out where they stand:
 * total required, paid so far, this request (or this payment), balance after.
 *
 * Pure: takes figures in, returns subject + html. Sending and logging live in
 * deposit-instalment-email-server.ts. WhatsApp/SMS are deliberately not here —
 * they keep the single-amount wording until a template with breakup fields is
 * approved at MSG91.
 */

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export interface PartEmailInput {
  proposalNumber: string;
  customerName: string;
  seq: number;
  /** Amount of THIS part (asked, or just received). */
  amount: number;
  required: number;
  /** Every part, including this one — status decides what counts as paid. */
  rows: InstalmentFigures[];
  payLinkUrl?: string | null;
  dueDate?: string | null;
  customerMessage?: string | null;
}

export interface PartEmailFigures {
  required: number;
  /** Paid before this part. */
  paidBefore: number;
  /** This part. */
  thisPart: number;
  /** Required − paid before − this part. */
  balanceAfter: number;
  /** Part number of how many parts are known so far (asked or paid). */
  partLabel: string;
  isFinal: boolean;
}

/** Figures for a request: nothing of this part is paid yet. */
export function requestFigures(input: PartEmailInput): PartEmailFigures {
  const others = input.rows.filter((r) => r.status === "paid");
  const pos = depositPosition(input.required, others);
  const balanceAfter = Math.max(0, Math.round((pos.balance - input.amount) * 100) / 100);
  return {
    required: input.required,
    paidBefore: pos.paid,
    thisPart: input.amount,
    balanceAfter,
    partLabel: `Part ${input.seq}`,
    isFinal: balanceAfter === 0,
  };
}

/** Figures for a receipt: `rows` already holds this part as paid. */
export function receivedFigures(input: PartEmailInput): PartEmailFigures {
  const pos = depositPosition(input.required, input.rows);
  const paidBefore = Math.max(0, Math.round((pos.paid - input.amount) * 100) / 100);
  return {
    required: input.required,
    paidBefore,
    thisPart: input.amount,
    balanceAfter: pos.balance,
    partLabel: `Part ${input.seq}`,
    isFinal: pos.balance === 0,
  };
}

function row(label: string, value: string, opts: { strong?: boolean; last?: boolean; accent?: boolean } = {}): string {
  const border = opts.last ? "" : "border-bottom:1px solid #e5e7eb;";
  return `<tr><td style="padding:10px 16px;color:#666;${border}">${label}</td><td style="padding:10px 16px;text-align:right;${border}${opts.strong ? "font-weight:bold;" : ""}${opts.accent ? "color:#015E65;font-size:18px;" : "color:#333;"}">${value}</td></tr>`;
}

function breakupTable(f: PartEmailFigures, thisLabel: string, balanceLabel: string): string {
  return `<table style="border-collapse:collapse;margin:20px 0;width:100%;background:#f0faf5;border-radius:6px;">
    ${row("Total security deposit", rupees(f.required), { strong: true })}
    ${row("Paid so far", rupees(f.paidBefore))}
    ${row(thisLabel, rupees(f.thisPart), { strong: true, accent: true })}
    ${row(balanceLabel, rupees(f.balanceAfter), { last: true })}
  </table>`;
}

function shell(subtitle: string, body: string): string {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">${subtitle}</p>
      </div>
      <div style="padding:32px;">${body}
        <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>`;
}

function customerNote(message?: string | null): string {
  if (!message) return "";
  return `<div style="background:#f0faf5;border-left:3px solid #015E65;border-radius:0 6px 6px 0;padding:10px 14px;margin:0 0 16px;">
    <p style="color:#0f6e56;font-size:13px;margin:0;font-style:italic;">${escapeHtml(message).replace(/\n/g, "<br/>")}</p>
  </div>`;
}

/** Asking the customer for the next part of the deposit. */
export function buildPartRequestEmail(input: PartEmailInput): { subject: string; html: string; figures: PartEmailFigures } {
  const f = requestFigures(input);
  const name = escapeHtml(input.customerName || "Customer");
  const due = input.dueDate ? ` by <strong>${escapeHtml(input.dueDate)}</strong>` : "";
  const payButton = input.payLinkUrl
    ? `<div style="text-align:center;margin:24px 0;">
         <a href="${escapeHtml(input.payLinkUrl)}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay ${rupees(f.thisPart)}</a>
         <p style="color:#666;font-size:11px;margin:8px 0 0;">Secure payment via Razorpay</p>
       </div>`
    : "";
  const bank = `<p style="color:#015E65;font-size:13px;font-weight:bold;margin:20px 0 8px;">${input.payLinkUrl ? "Or pay by bank transfer" : "Bank Transfer"}</p>
    <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;">
      <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;width:40%;">Account</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
      <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">A/C No</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
      <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">IFSC</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
      <tr><td style="padding:8px 16px;color:#666;font-weight:600;">Payment Reference</td><td style="padding:8px 16px;color:#015E65;font-weight:700;">${escapeHtml(input.proposalNumber)}</td></tr>
    </table>`;
  const body = `
    <p style="color:#333;font-size:14px;">Dear ${name},</p>
    <p style="color:#333;font-size:14px;">As agreed, the refundable security deposit for proposal <strong>${escapeHtml(input.proposalNumber)}</strong> is being collected in parts. Please pay <strong>${f.partLabel}</strong> of <strong>${rupees(f.thisPart)}</strong>${due}.</p>
    ${customerNote(input.customerMessage)}
    ${breakupTable(f, `Requested now (${f.partLabel})`, "Balance after this payment")}
    <p style="color:#666;font-size:12px;margin:0 0 4px;">${f.isFinal ? "This is the final part — your deposit will be complete once it is paid." : "The remaining balance will be requested separately. Your contract can be activated once the full deposit is received."}</p>
    ${payButton}
    ${bank}`;
  return {
    subject: `Security Deposit ${f.partLabel} — ${rupees(f.thisPart)} — ${input.proposalNumber} — The WorkVilla`,
    html: shell("Security Deposit — Part Payment Request", body),
    figures: f,
  };
}

/** Confirming a part that has just been received. */
export function buildPartReceivedEmail(input: PartEmailInput): { subject: string; html: string; figures: PartEmailFigures } {
  const f = receivedFigures(input);
  const name = escapeHtml(input.customerName || "Customer");
  const closing = f.isFinal
    ? `<div style="background:#f0faf5;border:1px solid #00AE6C;border-radius:6px;padding:10px 14px;"><p style="color:#0f6e56;font-size:13px;margin:0;"><strong>Your security deposit is now complete.</strong> Thank you.</p></div>`
    : `<p style="color:#666;font-size:12px;margin:0;">The balance of <strong>${rupees(f.balanceAfter)}</strong> is still to be paid before the contract can be activated. We will send you a separate request for it.</p>`;
  const body = `
    <p style="color:#333;font-size:14px;">Dear ${name},</p>
    <p style="color:#333;font-size:14px;">We have received <strong>${f.partLabel}</strong> of your security deposit for proposal <strong>${escapeHtml(input.proposalNumber)}</strong>. Thank you.</p>
    ${breakupTable(f, `Received now (${f.partLabel})`, "Balance still to pay")}
    ${closing}`;
  return {
    subject: `Security deposit received — ${f.partLabel} ${rupees(f.thisPart)} — ${input.proposalNumber} — The WorkVilla`,
    html: shell("Security Deposit — Payment Received", body),
    figures: f,
  };
}

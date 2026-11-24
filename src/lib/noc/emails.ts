// Pure builders for the three emails of the NOC service. No I/O: the routes decide who gets them and send them
// (after the safe-send check). Plain, branded HTML with every customer-supplied value escaped.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const shell = (inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1b1e;max-width:560px;margin:0 auto;font-size:14px;line-height:1.55">${inner}<p style="color:#64748b;font-size:12px;margin-top:24px">The WorkVilla · Sree Design Infrastructure Pvt Ltd</p></div>`;

const button = (href: string, label: string) =>
  `<p style="margin:18px 0"><a href="${esc(href)}" style="background:#015E65;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;display:inline-block">${esc(label)}</a></p>`;

const table = (rows: [string, string][]) =>
  `<table style="border-collapse:collapse;width:100%;margin:12px 0">${rows
    .map(([k, v], i) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:#64748b">${esc(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;${i === rows.length - 1 ? "font-weight:700" : ""}">${esc(v)}</td></tr>`)
    .join("")}</table>`;

export interface OfferEmailInput {
  customerName: string; companyName: string; purposeLabel: string; centre: string;
  feeExcl: number; tax: number; taxPercentage: number; total: number; validUntilLabel: string; invoiceNumber: string; link: string;
}

/** Sent by staff with the proforma invoice attached. The button opens our page, where the terms are accepted before payment. */
export function buildOfferEmail(i: OfferEmailInput) {
  return {
    subject: `NOC for ${i.companyName}: proforma invoice ${i.invoiceNumber} and payment link`,
    html: shell(
      `<p>Dear ${esc(i.customerName)},</p>
       <p>As requested, The WorkVilla can issue a No Objection Certificate so that <b>${esc(i.companyName)}</b> can use our <b>${esc(i.centre)}</b> centre for <b>${esc(i.purposeLabel)}</b>.</p>` +
        table([["NOC fee", rupees(i.feeExcl)], [`GST ${i.taxPercentage}%`, rupees(i.tax)], ["Total", rupees(i.total)]]) +
        `<p>The proforma invoice ${esc(i.invoiceNumber)} is attached. The NOC is issued after the full fee is received, and it stays valid until <b>${esc(i.validUntilLabel)}</b>, the end of your agreement.</p>` +
        button(i.link, "Review the terms and pay") +
        `<p style="color:#64748b;font-size:12px">The button opens our page first. You will be asked to read and accept the terms, confirm your name with a one-time code, and then you go to the secure payment page.</p>`,
    ),
  };
}

export function buildCodeEmail(i: { code: string; companyName: string; minutes: number }) {
  return {
    subject: `Your code for the ${i.companyName} NOC`,
    html: shell(
      `<p>Your one-time code is:</p>
       <p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:10px 0">${esc(i.code)}</p>
       <p>Enter it on the NOC page to confirm it is you. It works for ${i.minutes} minutes. If you did not ask for it, you can ignore this email.</p>`,
    ),
  };
}

export interface ReceiptEmailInput {
  customerName: string; companyName: string; purposeLabel: string; centre: string; total: number; paidOnLabel: string;
  reference: string | null; validUntilLabel: string; invoiceNumber: string;
}

/** Sent when the payment is recorded. The acceptance certificate is attached. */
export function buildReceiptEmail(i: ReceiptEmailInput) {
  return {
    subject: `Payment received for the ${i.companyName} NOC`,
    html: shell(
      `<p>Dear ${esc(i.customerName)},</p>
       <p>We have received your payment for the NOC for <b>${esc(i.companyName)}</b>. Thank you.</p>` +
        table([
          ["For", `NOC · ${i.purposeLabel} · ${i.centre}`], ["Invoice", i.invoiceNumber], ["Paid on", i.paidOnLabel],
          ["Payment reference", i.reference || "recorded by our accounts team"], ["Valid till", i.validUntilLabel], ["Amount", rupees(i.total)],
        ]) +
        `<p>The acceptance certificate for the terms you confirmed is attached for your records. Your NOC will be issued and sent to you shortly. A GST invoice will follow from our accounts team.</p>`,
    ),
  };
}

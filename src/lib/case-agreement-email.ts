import { renewalRecipients, type RenewalRoutableCase } from "@/lib/renewal-recipients";

/**
 * The email that carries a Leave & License agreement to the customer.
 *
 * Recipient follows the billing route via renewalRecipients() — the same
 * resolver the renewal notices and the KYC digest use. On an aggregator-billed
 * case the partner owns the client relationship, and 40 of the 46
 * aggregator-sourced cases hold no client email at all, so addressing the end
 * client directly would both cut across the partner and fail outright.
 *
 * Kept as a pure builder so the preview and the send cannot drift: the dialog
 * renders exactly the subject and body that get sent.
 */
export interface AgreementEmailCase extends RenewalRoutableCase {
  case_number?: string | null;
  location?: { name?: string | null } | null;
}

export interface AgreementEmail {
  to: string | null;
  toName: string;
  /** "aggregator" when a partner is being written to on the client's behalf. */
  toKind: "aggregator" | "client";
  /** The end client, when the recipient is someone else. */
  onBehalfOf: string | null;
  subject: string;
  html: string;
  /** Set when there is nobody to send to; the UI blocks on this. */
  blocked: string | null;
}

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildAgreementEmail(c: AgreementEmailCase): AgreementEmail {
  const routing = renewalRecipients(c);
  const to = routing.billing;
  const clientName = c.client_company_name || c.client_name;
  const onBehalfOf = to.kind === "aggregator" ? clientName : null;
  const caseRef = c.case_number ? ` (${c.case_number})` : "";
  const location = c.location?.name;

  const subject = onBehalfOf
    ? `Leave & License Agreement — ${clientName}${caseRef}`
    : `Your Leave & License Agreement${caseRef}`;

  const greeting = `Dear ${esc(to.name)},`;
  const opening = onBehalfOf
    ? `Please find attached the Leave &amp; License agreement for <strong>${esc(clientName)}</strong>${
        location ? ` at ${esc(location)}` : ""
      }.`
    : `Please find attached your Leave &amp; License agreement${
        location ? ` for ${esc(location)}` : ""
      }.`;

  const html = `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#ffffff;">
  <div style="background:#015E65;padding:22px 28px;">
    <h1 style="color:#ffffff;margin:0;font-size:19px;font-weight:700;">The WorkVilla</h1>
    <p style="color:#00AE6C;margin:5px 0 0;font-size:13px;font-weight:500;">Leave &amp; License Agreement</p>
  </div>

  <div style="padding:26px 28px;color:#374151;font-size:14px;line-height:1.65;">
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">${opening}</p>
    <p style="margin:0 0 14px;">
      Please review the attached document. Once you are satisfied with the terms, print it on
      stamp paper of the appropriate value, sign it, and return a scanned copy to us so we can
      complete execution.
    </p>
    <p style="margin:0 0 14px;">
      The attached copy is watermarked as a draft until the agreement is executed. Do reply to
      this email if anything needs correcting before you print it.
    </p>
    <p style="margin:18px 0 0;">Warm regards,<br/>The WorkVilla</p>
  </div>

  <div style="background:#015E65;padding:14px 28px;text-align:center;">
    <p style="color:#ffffff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
    <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
  </div>
</div>`.trim();

  return {
    to: to.email,
    toName: to.name,
    toKind: to.kind,
    onBehalfOf,
    subject,
    html,
    blocked: routing.blocked ?? (to.email ? null : `No email address on record for ${to.name}.`),
  };
}

/** Split a comma/semicolon/newline separated CC box into validated addresses. */
export function parseCcList(raw: string | string[] | undefined): {
  emails: string[];
  invalid: string[];
} {
  const parts = (Array.isArray(raw) ? raw.join(",") : raw ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const emails: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    // Deliberately loose: enough to catch a typo, not to adjudicate RFC 5322.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) {
      if (!emails.includes(p)) emails.push(p);
    } else {
      invalid.push(p);
    }
  }
  return { emails, invalid };
}

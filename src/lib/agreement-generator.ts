import Handlebars from "handlebars";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";
import { VO_PURPOSE_LABELS, ENTITY_TYPE_LABELS } from "@/lib/constants";
import type { VoPurpose, EntityType } from "@/types";

// TWV Brand Colors
const BRAND_TEAL: [number, number, number] = [1, 94, 101];
const BRAND_GREEN: [number, number, number] = [0, 174, 108];
const BRAND_DARK: [number, number, number] = [26, 27, 30];

const COMPANY_NAME = "SREE DESIGN INFRASTRUCTURE PVT LTD";
const BRAND_NAME = "The WorkVilla";
const COMPANY_ADDRESS = [
  "Prakash Presidium, 110, Mahatma Gandhi Road,",
  "Nungambakkam, Chennai - 600034",
];
const COMPANY_PHONE = "+91 97910 97900";
const COMPANY_WEBSITE = "www.theworkvilla.com";
const COMPANY_GST = "GST: 33AAACU4245J1ZF";

function formatCurrency(amount: number): string {
  return (
    "Rs. " +
    new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount)
  );
}

function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ================================================================
// Agreement Template Keys
// ================================================================

export type AgreementTemplateKey =
  | "vo_gst_registration"
  | "vo_mca_registration"
  | "vo_branch_office"
  | "vo_mail_handling"
  | "vo_business_address";

/**
 * Map a virtual office purpose to the agreement template key.
 */
export function getTemplateKey(purpose: VoPurpose): AgreementTemplateKey {
  const map: Record<VoPurpose, AgreementTemplateKey> = {
    gst_registration: "vo_gst_registration",
    mca_registration: "vo_mca_registration",
    branch_office: "vo_branch_office",
    mail_handling: "vo_mail_handling",
    business_address: "vo_business_address",
  };
  return map[purpose];
}

// ================================================================
// Agreement Templates (Handlebars)
// ================================================================

const AGREEMENT_TEMPLATES: Record<AgreementTemplateKey, string> = {
  vo_gst_registration: `
VIRTUAL OFFICE AGREEMENT FOR GST REGISTRATION

This Agreement is made on {{agreement_date}} between:

PARTY 1 (Service Provider):
{{company_name}}, operating as "{{brand_name}}", having its registered office at {{company_address}}.

PARTY 2 (Client):
{{client_name}}{{#if client_company_name}} ({{client_company_name}}){{/if}}, {{entity_type_label}}, having address at {{client_address}}.

PURPOSE: Provision of virtual office address for the purpose of GST Registration under the Goods and Services Tax Act, 2017.

SCHEDULE:
1. Address: {{location_name}}, {{location_address}}
2. Service: Virtual Office for GST Registration
3. Monthly Fee: {{rate_formatted}} + applicable GST
4. Tenure: {{tenure_months}} months from {{start_date_formatted}}
5. Security Deposit: {{security_deposit_formatted}}
{{#if client_gst_number}}6. Client GST: {{client_gst_number}}{{/if}}
{{#if client_pan_number}}7. Client PAN: {{client_pan_number}}{{/if}}

TERMS:
- The Service Provider shall provide a valid registered business address for the Client's GST registration.
- The Client shall use the address solely for GST registration and related statutory compliance.
- The Client shall not use the premises for any illegal or unauthorized activities.
- The Service Provider shall handle official correspondence and government notices received at the address.
- The agreement may be renewed upon mutual consent before expiry.
- Either party may terminate with 30 days written notice after the lock-in period.
`,

  vo_mca_registration: `
VIRTUAL OFFICE AGREEMENT FOR COMPANY/LLP REGISTRATION

This Agreement is made on {{agreement_date}} between:

PARTY 1 (Service Provider):
{{company_name}}, operating as "{{brand_name}}", having its registered office at {{company_address}}.

PARTY 2 (Client):
{{client_name}}{{#if client_company_name}} ({{client_company_name}}){{/if}}, {{entity_type_label}}, having address at {{client_address}}.

PURPOSE: Provision of registered office address for Company/LLP registration with the Ministry of Corporate Affairs (MCA).

SCHEDULE:
1. Address: {{location_name}}, {{location_address}}
2. Service: Registered Office Address for MCA Registration
3. Monthly Fee: {{rate_formatted}} + applicable GST
4. Tenure: {{tenure_months}} months from {{start_date_formatted}}
5. Security Deposit: {{security_deposit_formatted}}
{{#if client_cin_number}}6. CIN/LLPIN: {{client_cin_number}}{{/if}}
{{#if client_pan_number}}7. Client PAN: {{client_pan_number}}{{/if}}

TERMS:
- The Service Provider shall provide a valid address suitable for use as a registered office under the Companies Act, 2013 / LLP Act, 2008.
- The Client shall maintain all statutory filings with correct address details.
- The Service Provider shall provide a No Objection Certificate (NOC) and utility bill as proof of address.
- All government notices and correspondence received shall be forwarded to the Client within 24 hours.
- The agreement may be renewed upon mutual consent before expiry.
`,

  vo_branch_office: `
VIRTUAL OFFICE AGREEMENT FOR BRANCH OFFICE

This Agreement is made on {{agreement_date}} between:

PARTY 1 (Service Provider):
{{company_name}}, operating as "{{brand_name}}", having its registered office at {{company_address}}.

PARTY 2 (Client):
{{client_name}}{{#if client_company_name}} ({{client_company_name}}){{/if}}, {{entity_type_label}}, having address at {{client_address}}.

PURPOSE: Provision of virtual office address for establishing a branch office presence.

SCHEDULE:
1. Address: {{location_name}}, {{location_address}}
2. Service: Branch Office Virtual Address
3. Monthly Fee: {{rate_formatted}} + applicable GST
4. Tenure: {{tenure_months}} months from {{start_date_formatted}}
5. Security Deposit: {{security_deposit_formatted}}
{{#if client_gst_number}}6. Client GST: {{client_gst_number}}{{/if}}

TERMS:
- The Service Provider shall provide a valid branch office address.
- The Client may use the address for GST registration of the branch and related compliance.
- Mail handling and forwarding services are included.
- The agreement may be renewed upon mutual consent before expiry.
`,

  vo_mail_handling: `
VIRTUAL OFFICE AGREEMENT FOR MAIL HANDLING

This Agreement is made on {{agreement_date}} between:

PARTY 1 (Service Provider):
{{company_name}}, operating as "{{brand_name}}", having its registered office at {{company_address}}.

PARTY 2 (Client):
{{client_name}}{{#if client_company_name}} ({{client_company_name}}){{/if}}, {{entity_type_label}}, having address at {{client_address}}.

PURPOSE: Provision of business address with mail handling and forwarding services.

SCHEDULE:
1. Address: {{location_name}}, {{location_address}}
2. Service: Mail Handling & Business Address
3. Monthly Fee: {{rate_formatted}} + applicable GST
4. Tenure: {{tenure_months}} months from {{start_date_formatted}}
5. Security Deposit: {{security_deposit_formatted}}

TERMS:
- The Service Provider shall receive and sort all mail and deliveries on behalf of the Client.
- Mail notifications shall be sent via email/WhatsApp within 4 business hours of receipt.
- Physical mail forwarding is available at additional courier charges.
- The Client may collect mail during centre operating hours.
`,

  vo_business_address: `
VIRTUAL OFFICE AGREEMENT

This Agreement is made on {{agreement_date}} between:

PARTY 1 (Service Provider):
{{company_name}}, operating as "{{brand_name}}", having its registered office at {{company_address}}.

PARTY 2 (Client):
{{client_name}}{{#if client_company_name}} ({{client_company_name}}){{/if}}, {{entity_type_label}}, having address at {{client_address}}.

PURPOSE: Provision of virtual office services including business address and related facilities.

SCHEDULE:
1. Address: {{location_name}}, {{location_address}}
2. Service: Virtual Office & Business Address
3. Monthly Fee: {{rate_formatted}} + applicable GST
4. Tenure: {{tenure_months}} months from {{start_date_formatted}}
5. Security Deposit: {{security_deposit_formatted}}

TERMS:
- The Service Provider shall provide a professional business address for use on stationery, website, and business cards.
- Mail handling services are included.
- Meeting room access at published pay-per-use rates.
- The agreement may be renewed upon mutual consent before expiry.
`,
};

// ================================================================
// Variable Merging
// ================================================================

export interface AgreementVariables {
  agreement_date: string;
  agreement_number: string;
  company_name: string;
  brand_name: string;
  company_address: string;
  client_name: string;
  client_company_name?: string;
  client_entity_type: EntityType;
  entity_type_label: string;
  client_address: string;
  client_gst_number?: string;
  client_pan_number?: string;
  client_cin_number?: string;
  client_email?: string;
  client_phone?: string;
  location_name: string;
  location_address: string;
  purpose: VoPurpose;
  purpose_label: string;
  rate: number;
  rate_formatted: string;
  tenure_months: number;
  start_date: string;
  start_date_formatted: string;
  end_date: string;
  end_date_formatted: string;
  security_deposit: number;
  security_deposit_formatted: string;
}

/**
 * Build the template variables from case and related data.
 */
export function mergeVariables(params: {
  agreementNumber: string;
  agreementDate: string;
  clientName: string;
  clientCompanyName?: string;
  clientEntityType: EntityType;
  clientAddress: string;
  clientGstNumber?: string;
  clientPanNumber?: string;
  clientCinNumber?: string;
  clientEmail?: string;
  clientPhone?: string;
  locationName: string;
  locationAddress: string;
  purpose: VoPurpose;
  rate: number;
  tenureMonths: number;
  startDate: string;
  securityDeposit: number;
}): AgreementVariables {
  const startDate = new Date(params.startDate);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + params.tenureMonths);

  return {
    agreement_date: formatDate(params.agreementDate),
    agreement_number: params.agreementNumber,
    company_name: COMPANY_NAME,
    brand_name: BRAND_NAME,
    company_address: COMPANY_ADDRESS.join(" "),
    client_name: params.clientName,
    client_company_name: params.clientCompanyName,
    client_entity_type: params.clientEntityType,
    entity_type_label: ENTITY_TYPE_LABELS[params.clientEntityType] || params.clientEntityType,
    client_address: params.clientAddress || "To be provided",
    client_gst_number: params.clientGstNumber,
    client_pan_number: params.clientPanNumber,
    client_cin_number: params.clientCinNumber,
    client_email: params.clientEmail,
    client_phone: params.clientPhone,
    location_name: params.locationName,
    location_address: params.locationAddress,
    purpose: params.purpose,
    purpose_label: VO_PURPOSE_LABELS[params.purpose] || params.purpose,
    rate: params.rate,
    rate_formatted: formatCurrency(params.rate),
    tenure_months: params.tenureMonths,
    start_date: params.startDate,
    start_date_formatted: formatDate(params.startDate),
    end_date: endDate.toISOString(),
    end_date_formatted: formatDate(endDate),
    security_deposit: params.securityDeposit,
    security_deposit_formatted: formatCurrency(params.securityDeposit),
  };
}

/**
 * Compile a Handlebars template with variables and return the rendered text.
 */
export function renderAgreementText(
  templateKey: AgreementTemplateKey,
  variables: AgreementVariables
): string {
  const templateSource = AGREEMENT_TEMPLATES[templateKey];
  if (!templateSource) {
    throw new Error(`Unknown agreement template: ${templateKey}`);
  }

  const template = Handlebars.compile(templateSource);
  return template(variables);
}

/**
 * Generate a professional PDF for the virtual office agreement.
 */
export function generateAgreementPdf(
  templateKey: AgreementTemplateKey,
  variables: AgreementVariables
): jsPDF {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 15;
  const marginRight = 15;
  const contentWidth = pageWidth - marginLeft - marginRight;
  const maxY = pageHeight - 20;
  let y = 0;

  function checkPageBreak(needed: number): void {
    if (y + needed > maxY) {
      addFooter(doc);
      doc.addPage();
      y = 20;
    }
  }

  function addWrappedText(
    text: string,
    x: number,
    width: number,
    fontSize: number,
    style: string = "normal",
    color: [number, number, number] = [50, 50, 50],
    lineHeight: number = 5
  ): void {
    doc.setFontSize(fontSize);
    doc.setFont("helvetica", style);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, width);
    for (const line of lines) {
      checkPageBreak(lineHeight + 2);
      doc.text(line, x, y);
      y += lineHeight;
    }
  }

  // ── Header ──
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 25, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 25, pageWidth, 1.5, "F");

  doc.addImage(TWV_LOGO_BASE64, "PNG", marginLeft, 5, 50, 12.5);

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(255, 255, 255);
  doc.text(COMPANY_NAME, pageWidth - marginRight, 10, { align: "right" });
  doc.text(COMPANY_ADDRESS.join(" "), pageWidth - marginRight, 14, { align: "right" });
  doc.text(`${COMPANY_PHONE} | ${COMPANY_WEBSITE}`, pageWidth - marginRight, 18, { align: "right" });

  y = 38;

  // ── Title ──
  const titleText = `VIRTUAL OFFICE AGREEMENT`;
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(titleText, pageWidth / 2, y, { align: "center" });
  y += 3;

  const titleWidth = doc.getTextWidth(titleText);
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line((pageWidth - titleWidth) / 2, y, (pageWidth + titleWidth) / 2, y);
  y += 5;

  // Subtitle with purpose
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`For ${variables.purpose_label}`, pageWidth / 2, y, { align: "center" });
  y += 8;

  // ── Agreement number & date ──
  doc.setFontSize(10);
  doc.text(`Ref: ${variables.agreement_number}`, marginLeft, y);
  doc.text(`Date: ${variables.agreement_date}`, pageWidth - marginRight, y, { align: "right" });
  y += 10;

  // ── Render the agreement body ──
  const bodyText = renderAgreementText(templateKey, variables);
  const sections = bodyText.split("\n").filter((line) => line.trim());

  for (const line of sections) {
    const trimmed = line.trim();

    if (trimmed.startsWith("PARTY") || trimmed.startsWith("PURPOSE:") || trimmed.startsWith("SCHEDULE:") || trimmed.startsWith("TERMS:")) {
      y += 4;
      addWrappedText(trimmed, marginLeft, contentWidth, 10, "bold", BRAND_TEAL, 5);
      y += 2;
    } else if (/^\d+\./.test(trimmed)) {
      addWrappedText(trimmed, marginLeft + 4, contentWidth - 4, 9, "normal", [50, 50, 50], 4.5);
    } else if (trimmed.startsWith("-")) {
      addWrappedText(trimmed, marginLeft + 4, contentWidth - 4, 9, "normal", [50, 50, 50], 4.5);
    } else {
      addWrappedText(trimmed, marginLeft, contentWidth, 9, "normal", [50, 50, 50], 4.5);
    }
  }

  // ── Signature block ──
  y += 10;
  checkPageBreak(50);

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("IN WITNESS WHEREOF, the parties have executed this Agreement.", marginLeft, y);
  y += 15;

  const colWidth = (contentWidth - 20) / 2;
  const col1X = marginLeft;
  const col2X = marginLeft + colWidth + 20;

  // Operator
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("For " + BRAND_NAME, col1X, y);
  doc.text("For " + (variables.client_company_name || variables.client_name), col2X, y);
  y += 20;

  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.3);
  doc.line(col1X, y, col1X + colWidth, y);
  doc.line(col2X, y, col2X + colWidth, y);
  y += 5;

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("Authorized Signatory", col1X, y);
  doc.text("Authorized Signatory", col2X, y);
  y += 5;
  doc.text(`Date: ${variables.agreement_date}`, col1X, y);
  doc.text(`Date: ${variables.agreement_date}`, col2X, y);

  // ── Footer on all pages ──
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addFooter(doc);
  }

  return doc;
}

function addFooter(doc: jsPDF): void {
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();

  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, ph - 14, pw, 14, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, ph - 14, pw, 0.8, "F");

  doc.setFontSize(6.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text(`${BRAND_NAME}  |  ${COMPANY_NAME}`, pw / 2, ph - 8, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  doc.setTextColor(200, 230, 220);
  doc.text(
    `${COMPANY_ADDRESS.join(" ")}  |  ${COMPANY_PHONE}  |  ${COMPANY_WEBSITE}`,
    pw / 2,
    ph - 4,
    { align: "center" }
  );
}

// Suppress unused import warnings for autoTable — it attaches to jsPDF prototype
void autoTable;

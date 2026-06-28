/**
 * VO Discontinuation — draft document generator
 *
 * Generates three document types as draft PDFs stored in crm-documents/
 * Each requires admin/manager approval before being sent or dispatched.
 *
 * Document types:
 *   1. discontinuation_notice  — sent to client via email
 *   2. dos_donts               — sent to client via email
 *   3. authority_letter        — generated per authority (GST, ROC, etc.)
 *                                dispatched by registered post manually
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  addBrandHeader,
  addFooter,
  BRAND_TEAL,
  BRAND_DARK,
  COMPANY_NAME,
  COMPANY_ADDRESS,
} from "@/lib/pdf-utils";
// Note: COMPANY_ADDRESS is an array of address lines
import { formatDate } from "@/lib/utils";
import { VO_PURPOSE_LABELS } from "@/lib/constants";

autoTable; // suppress unused import

autoTable; // suppress unused import warning

// ---------------------------------------------------------------------------
// Authority routing by purpose
// ---------------------------------------------------------------------------

interface Authority {
  name: string;
  addressLines: string[];
  subject: (clientName: string, gstin?: string, cin?: string) => string;
  bodyParagraphs: (params: AuthorityLetterParams) => string[];
}

interface AuthorityLetterParams {
  clientName: string;
  clientCompanyName?: string | null;
  clientGstin?: string | null;
  clientCin?: string | null;
  locationName: string;
  locationAddress: string;
  effectiveDate: string;
  purpose: string;
}

const AUTHORITY_MAP: Record<string, Authority[]> = {
  gst_registration: [
    {
      name: "The Jurisdictional GST Officer",
      addressLines: [
        "Central Tax Office",
        "Chennai (applicable jurisdiction)",
        "Tamil Nadu",
      ],
      subject: (clientName, gstin) =>
        `Notice of Discontinuation of Virtual Office Address — ${clientName}${gstin ? ` (GSTIN: ${gstin})` : ""}`,
      bodyParagraphs: (p) => [
        `We, ${COMPANY_NAME} (hereinafter "Service Provider"), having our registered office at ${COMPANY_ADDRESS.join(", ")}, write to inform your office that the virtual office / registered address services provided by us to the entity mentioned below have been discontinued effective ${formatDate(p.effectiveDate)}, due to non-renewal of the Leave & License Agreement.`,
        `Client Details:\nEntity Name: ${p.clientCompanyName || p.clientName}\nGSTIN: ${p.clientGstin || "Not available"}\nAddress used for GST registration: ${p.locationName}, ${p.locationAddress}`,
        `The above address is NO LONGER authorised for use by the said entity for any GST-related correspondence, filing, or registration purpose effective the date mentioned above. ${COMPANY_NAME} bears no responsibility for any correspondence, notices, or compliance obligations addressed to the above entity at this address after the effective date of discontinuation.`,
        `We request your office to take appropriate note of this discontinuation and update your records accordingly. We are available to provide any further documentation required for this purpose.`,
      ],
    },
  ],
  mca_registration: [
    {
      name: "The Registrar of Companies",
      addressLines: [
        "Office of the Registrar of Companies",
        "Tamil Nadu & Pondicherry",
        "Shastri Bhawan, No. 26, Haddows Road",
        "Chennai – 600006",
      ],
      subject: (clientName, _gstin, cin) =>
        `Notice of Change of Registered Office Address — ${clientName}${cin ? ` (CIN: ${cin})` : ""}`,
      bodyParagraphs: (p) => [
        `We, ${COMPANY_NAME}, having our registered office at ${COMPANY_ADDRESS.join(", ")}, write to inform your office that the virtual office / registered address services provided by us to the company mentioned below have been discontinued effective ${formatDate(p.effectiveDate)}.`,
        `Company Details:\nCompany Name: ${p.clientCompanyName || p.clientName}\nCIN: ${p.clientCin || "Not available"}\nFormer Registered Address: ${p.locationName}, ${p.locationAddress}`,
        `The above address is NO LONGER authorised as the registered office of the said company effective the date of discontinuation. The company is required under the Companies Act, 2013 to update their registered office address with your office within the prescribed timelines. ${COMPANY_NAME} accepts no liability for any filings, communications, or regulatory actions directed to this address after the said date.`,
        `We request your office to take note of this change and advise the company to comply with the applicable provisions for updating their registered office address.`,
      ],
    },
  ],
  branch_office: [
    {
      name: "The Jurisdictional GST Officer",
      addressLines: [
        "Central Tax Office",
        "Chennai (applicable jurisdiction)",
        "Tamil Nadu",
      ],
      subject: (clientName, gstin) =>
        `Notice of Discontinuation of Branch Office Address — ${clientName}${gstin ? ` (GSTIN: ${gstin})` : ""}`,
      bodyParagraphs: (p) => [
        `We, ${COMPANY_NAME}, write to inform your office that the branch office virtual address services at ${p.locationName}, ${p.locationAddress}, provided to ${p.clientCompanyName || p.clientName}, have been discontinued effective ${formatDate(p.effectiveDate)} due to non-renewal.`,
        `The said entity's GSTIN for this branch location is ${p.clientGstin || "not available on record"}. This address is no longer authorised as a branch address for any regulatory, GST, or business correspondence purpose.`,
        `We request your office to update your records accordingly.`,
      ],
    },
  ],
  // mail_handling and business_address — no formal authority letter required
};

// ---------------------------------------------------------------------------
// Generate discontinuation notice PDF
// ---------------------------------------------------------------------------

export function generateDiscontinuationNotice(params: {
  caseNumber: string;
  clientName: string;
  clientCompanyName?: string | null;
  locationName: string;
  effectiveDate: string;
  purpose: string;
}): Buffer {
  const { caseNumber, clientName, clientCompanyName, locationName, effectiveDate, purpose } = params;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ML = 15;
  const CW = doc.internal.pageSize.getWidth() - ML - 15;

  let y = addBrandHeader(doc);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  doc.text("NOTICE OF DISCONTINUATION OF VIRTUAL OFFICE SERVICES", ML, y);
  y += 8;

  const clientDisplay = clientCompanyName || clientName;
  const purposeLabel = VO_PURPOSE_LABELS[purpose as keyof typeof VO_PURPOSE_LABELS] ?? purpose;
  doc.setFontSize(9);
  doc.setFontSize(9);
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);

  const writeParas = (lines: string[]) => {
    lines.forEach((line) => {
      const wrapped = doc.splitTextToSize(line, CW);
      doc.text(wrapped, ML, y);
      y += wrapped.length * 5 + 4;
    });
  };

  doc.setFont("helvetica", "bold");
  doc.text(`Ref: TWV/${caseNumber}/DISC/${new Date().getFullYear()}`, ML, y);
  doc.text(`Date: ${formatDate(new Date().toISOString())}`, 210 - 15 - 50, y);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.text(`To,`, ML, y); y += 5;
  doc.text(clientDisplay, ML, y); y += 5;
  if (clientCompanyName) { doc.text(clientName, ML, y); y += 5; }
  y += 4;

  doc.setFont("helvetica", "bold");
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  const subjectLine = `Sub: Discontinuation of Virtual Office Services — ${locationName} — Effective ${formatDate(effectiveDate)}`;
  const wrappedSubject = doc.splitTextToSize(subjectLine, CW);
  doc.text(wrappedSubject, ML, y);
  y += wrappedSubject.length * 5 + 6;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);

  writeParas([
    `Dear ${clientDisplay},`,
    `We write to inform you that the Virtual Office Agreement (Purpose: ${purposeLabel}) entered into between ${COMPANY_NAME} and yourself for the use of our premises at ${locationName} has not been renewed. Accordingly, all virtual office services provided under the said agreement stand discontinued effective ${formatDate(effectiveDate)}.`,
    `The services that stand discontinued include but are not limited to: use of the above address for business, GST, MCA, banking, or any other official purpose; mail handling and forwarding; and any associated services contracted under the said agreement.`,
    `You are required to:\n  1. Update your business address with all relevant authorities (GST, ROC, banks, etc.) immediately.\n  2. Cease using the above address for any official, business, or regulatory purpose forthwith.\n  3. Inform all your correspondents of the change of address without delay.`,
    `Failure to update your registered address with the relevant authorities may result in compliance issues for which ${COMPANY_NAME} bears no responsibility. Please treat this matter as urgent.`,
    `Should you wish to renew your agreement, please contact our team at billing@theworkvilla.com within 7 days of this notice.`,
    `Yours sincerely,\n\n\n_________________________\nAuthorised Signatory\n${COMPANY_NAME}`,
  ]);

  addFooter(doc);
  return Buffer.from(doc.output("arraybuffer"));
}

// ---------------------------------------------------------------------------
// Generate Dos & Don'ts PDF
// ---------------------------------------------------------------------------

export function generateDosDonts(params: {
  caseNumber: string;
  clientName: string;
  clientCompanyName?: string | null;
  locationName: string;
  effectiveDate: string;
}): Buffer {
  const { caseNumber, clientName, clientCompanyName, locationName, effectiveDate } = params;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ML = 15;
  const CW = doc.internal.pageSize.getWidth() - ML - 15;

  let y = addBrandHeader(doc);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  doc.text("DOS AND DON'TS AFTER VIRTUAL OFFICE DISCONTINUATION", ML, y);
  y += 8;
  doc.setFontSize(9);
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);

  const clientDisplay = clientCompanyName || clientName;

  doc.setFont("helvetica", "normal");
  doc.text(`Client: ${clientDisplay}`, ML, y); y += 5;
  doc.text(`Location: ${locationName}`, ML, y); y += 5;
  doc.text(`Effective Date: ${formatDate(effectiveDate)}`, ML, y); y += 5;
  doc.text(`Ref: TWV/${caseNumber}/DISC/${new Date().getFullYear()}`, ML, y); y += 10;

  const doItems = [
    "Update your registered address with the GST department immediately and file the necessary amendment on the GST portal.",
    "File Form INC-22 (or DIR-12 if applicable) with the Registrar of Companies to update your registered office address.",
    "Inform your bank(s) of the change in your business address and update KYC records.",
    "Update your address with any professional bodies, trade associations, or licensing authorities.",
    "Ensure all pending mail / courier at The WorkVilla is collected within 7 days. After this period, uncollected mail may be returned to sender.",
    "Retain a copy of this notice and all correspondence with The WorkVilla for your records.",
  ];

  const dontItems = [
    "Do NOT continue to use The WorkVilla address for any purpose — business cards, websites, email signatures, government filings, banking, or client communication.",
    "Do NOT give The WorkVilla address to any new correspondents or authorities after the effective date of discontinuation.",
    "Do NOT ignore compliance timelines — late updating of registered address attracts penalties under the Companies Act and GST regulations.",
    "Do NOT assume mail addressed to you will be forwarded after the agreement ends — this service ceases on the effective date.",
    "Do NOT represent that you are still a client or occupant at The WorkVilla premises after the discontinuation date.",
  ];

  // DOs
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 128, 0);
  doc.text("✓  WHAT YOU MUST DO", ML, y); y += 6;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
  doItems.forEach((item, i) => {
    const wrapped = doc.splitTextToSize(`${i + 1}.  ${item}`, CW - 5);
    doc.text(wrapped, ML + 4, y);
    y += wrapped.length * 5 + 3;
  });

  y += 4;

  // DON'Ts
  doc.setFont("helvetica", "bold");
  doc.setTextColor(180, 0, 0);
  doc.text("✗  WHAT YOU MUST NOT DO", ML, y); y += 6;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
  dontItems.forEach((item, i) => {
    const wrapped = doc.splitTextToSize(`${i + 1}.  ${item}`, CW - 5);
    doc.text(wrapped, ML + 4, y);
    y += wrapped.length * 5 + 3;
  });

  y += 6;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text(
    `This document is issued by ${COMPANY_NAME} for compliance purposes. For queries, contact billing@theworkvilla.com`,
    ML,
    y
  );

  addFooter(doc);
  return Buffer.from(doc.output("arraybuffer"));
}

// ---------------------------------------------------------------------------
// Generate authority notification letter PDF
// ---------------------------------------------------------------------------

export function generateAuthorityLetter(params: AuthorityLetterParams & {
  authority: Authority;
  caseNumber: string;
}): Buffer {
  const { authority, caseNumber, ...letterParams } = params;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ML = 15;
  const CW = doc.internal.pageSize.getWidth() - ML - 15;

  let y = addBrandHeader(doc);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  doc.text("OFFICIAL COMMUNICATION", ML, y);
  y += 8;
  doc.setFontSize(9);
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);

  doc.setFont("helvetica", "normal");
  doc.text(`Ref: TWV/${caseNumber}/AUTH/${new Date().getFullYear()}`, ML, y);
  doc.text(`Date: ${formatDate(new Date().toISOString())}`, 210 - 15 - 50, y);
  y += 8;

  // Addressee
  doc.setFont("helvetica", "bold");
  doc.text("To,", ML, y); y += 5;
  doc.setFont("helvetica", "normal");
  doc.text(authority.name, ML, y); y += 5;
  authority.addressLines.forEach((line) => {
    doc.text(line, ML, y);
    y += 5;
  });
  y += 4;

  // Subject
  const subjectText = authority.subject(
    letterParams.clientName,
    letterParams.clientGstin ?? undefined,
    letterParams.clientCin ?? undefined
  );
  doc.setFont("helvetica", "bold");
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  const wrappedSub = doc.splitTextToSize(`Sub: ${subjectText}`, CW);
  doc.text(wrappedSub, ML, y);
  y += wrappedSub.length * 5 + 6;

  // Body paragraphs
  doc.setFont("helvetica", "normal");
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
  const paras = authority.bodyParagraphs(letterParams);
  paras.forEach((para) => {
    const lines = para.split("\n");
    lines.forEach((line) => {
      const wrapped = doc.splitTextToSize(line || " ", CW);
      doc.text(wrapped, ML, y);
      y += wrapped.length * 5;
    });
    y += 5;
  });

  // Signature block
  y += 6;
  doc.text("Yours faithfully,", ML, y); y += 12;
  doc.text("_________________________", ML, y); y += 5;
  doc.setFont("helvetica", "bold");
  doc.text("Authorised Signatory", ML, y); y += 5;
  doc.text(COMPANY_NAME, ML, y); y += 5;
  doc.setFont("helvetica", "normal");

  // Registered post note box
  y += 8;
  doc.setDrawColor(200, 200, 200);
  doc.setFillColor(249, 250, 251);
  doc.roundedRect(ML, y, CW, 24, 2, 2, "FD");
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text("DISPATCH BY REGISTERED POST", ML + 4, y + 6);
  doc.text(`Postal Article No.: ________________________`, ML + 4, y + 12);
  doc.text(`Dispatched by: ________________________  Date: ________________________`, ML + 4, y + 18);

  addFooter(doc);
  return Buffer.from(doc.output("arraybuffer"));
}

// ---------------------------------------------------------------------------
// Get list of authorities for a given purpose
// ---------------------------------------------------------------------------

export function getAuthoritiesForPurpose(purpose: string): Authority[] {
  return AUTHORITY_MAP[purpose] ?? [];
}

// ---------------------------------------------------------------------------
// Generate and store all discontinuation documents as drafts
// ---------------------------------------------------------------------------

export async function generateDiscontinuationDrafts(params: {
  adminSupabase: SupabaseClient;
  caseId: string;
  caseNumber: string;
  clientName: string;
  clientCompanyName?: string | null;
  clientGstin?: string | null;
  clientCin?: string | null;
  locationName: string;
  locationAddress: string;
  effectiveDate: string;
  purpose: string;
}): Promise<void> {
  const {
    adminSupabase,
    caseId,
    caseNumber,
    clientName,
    clientCompanyName,
    clientGstin,
    clientCin,
    locationName,
    locationAddress,
    effectiveDate,
    purpose,
  } = params;

  const ts = Date.now();

  const uploadAndRecord = async (
    buffer: Buffer,
    fileName: string,
    docType: string,
    authorityName?: string,
    authorityAddress?: string
  ) => {
    const path = `case-documents/${caseId}/discontinuation/${fileName}`;
    const { error } = await adminSupabase.storage
      .from("crm-documents")
      .upload(path, buffer, { contentType: "application/pdf", upsert: true });

    if (error) {
      console.error(`[vo-discontinuation] Upload failed for ${fileName}:`, error.message);
      return;
    }

    await adminSupabase.from("vo_discontinuation_documents").insert({
      case_id: caseId,
      document_type: docType,
      authority_name: authorityName ?? null,
      authority_address: authorityAddress ?? null,
      document_path: path,
      status: "draft",
    });
  };

  // 1. Discontinuation notice
  const noticePdf = generateDiscontinuationNotice({
    caseNumber,
    clientName,
    clientCompanyName,
    locationName,
    effectiveDate,
    purpose,
  });
  await uploadAndRecord(noticePdf, `${ts}-discontinuation-notice.pdf`, "discontinuation_notice");

  // 2. Dos & Don'ts
  const dosDontsPdf = generateDosDonts({
    caseNumber,
    clientName,
    clientCompanyName,
    locationName,
    effectiveDate,
  });
  await uploadAndRecord(dosDontsPdf, `${ts}-dos-donts.pdf`, "dos_donts");

  // 3. Authority letters (by purpose)
  const authorities = getAuthoritiesForPurpose(purpose);
  for (const authority of authorities) {
    const letterPdf = generateAuthorityLetter({
      authority,
      caseNumber,
      clientName,
      clientCompanyName,
      clientGstin,
      clientCin,
      locationName,
      locationAddress,
      effectiveDate,
      purpose,
    });
    const safeName = authority.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    await uploadAndRecord(
      letterPdf,
      `${ts}-authority-letter-${safeName}.pdf`,
      "authority_letter",
      authority.name,
      authority.addressLines.join(", ")
    );
  }
}

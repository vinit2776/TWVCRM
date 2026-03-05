/**
 * Leave & License Agreement PDF Generator
 *
 * Generates a full legal Leave & License Agreement based on the TWV template.
 * Uses jsPDF with shared branding from pdf-utils.ts.
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { VO_PURPOSE_LABELS, ENTITY_TYPE_LABELS } from "@/lib/constants";
import {
  BRAND_TEAL,
  BRAND_DARK,
  COMPANY_NAME,
  BRAND_NAME,
  COMPANY_ADDRESS,
  LL_PROPERTY_ADDRESS,
  LESSOR_DIRECTOR,
  formatCurrency,
  formatDate,
  addBrandHeader,
  addFooter,
  createPdfContext,
} from "@/lib/pdf-utils";
import type { VoPurpose, EntityType } from "@/types";

// ================================================================
// L&L Agreement Variables
// ================================================================

export interface LeaveLicenseVariables {
  // Standard fields
  agreement_date: string;
  agreement_number: string;
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
  property_address: string;
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
  // L&L-specific fields
  lessor_signatory_name: string;
  lessee_signatory_name: string;
  lessee_signatory_designation?: string;
  nature_of_business: string;
  witness_1_name?: string;
  witness_1_aadhaar_last4?: string;
  witness_2_name?: string;
  witness_2_aadhaar_last4?: string;
  estamp_value?: number;
  estamp_value_formatted?: string;
  service_retainer_deposit: number;
  service_retainer_deposit_formatted: string;
}

/**
 * Build L&L template variables from case data.
 */
export function mergeLeaveLicenseVariables(params: {
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
  natureOfBusiness?: string;
  lesseeSignatoryName?: string;
  lesseeSignatoryDesignation?: string;
  witness1Name?: string;
  witness1AadhaarLast4?: string;
  witness2Name?: string;
  witness2AadhaarLast4?: string;
  estampValue?: number;
}): LeaveLicenseVariables {
  const startDate = new Date(params.startDate);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + params.tenureMonths);
  const serviceRetainer = 1000; // Fixed INR 1000 + GST as per template

  return {
    agreement_date: formatDate(params.agreementDate),
    agreement_number: params.agreementNumber,
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
    property_address: LL_PROPERTY_ADDRESS,
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
    lessor_signatory_name: LESSOR_DIRECTOR,
    lessee_signatory_name: params.lesseeSignatoryName || params.clientName,
    lessee_signatory_designation: params.lesseeSignatoryDesignation || "Authorized Signatory",
    nature_of_business: params.natureOfBusiness || "To be provided",
    witness_1_name: params.witness1Name,
    witness_1_aadhaar_last4: params.witness1AadhaarLast4,
    witness_2_name: params.witness2Name,
    witness_2_aadhaar_last4: params.witness2AadhaarLast4,
    estamp_value: params.estampValue,
    estamp_value_formatted: params.estampValue ? formatCurrency(params.estampValue) : undefined,
    service_retainer_deposit: serviceRetainer,
    service_retainer_deposit_formatted: formatCurrency(serviceRetainer),
  };
}

// ================================================================
// Purpose-specific clauses
// ================================================================

function getPurposeClause(purpose: VoPurpose): string {
  const clauses: Record<VoPurpose, string> = {
    gst_registration:
      "The Lessee shall use the Licensed Premises solely for the purpose of GST Registration under the Goods and Services Tax Act, 2017 and related statutory compliance.",
    mca_registration:
      "The Lessee shall use the Licensed Premises solely for the purpose of Company/LLP Registration with the Ministry of Corporate Affairs (MCA) under the Companies Act, 2013 / LLP Act, 2008.",
    branch_office:
      "The Lessee shall use the Licensed Premises as a branch office address for business operations, GST registration, and related compliance.",
    mail_handling:
      "The Lessee shall use the Licensed Premises for receiving business correspondence, mail handling, and as a professional business address.",
    business_address:
      "The Lessee shall use the Licensed Premises as a virtual office and professional business address for their operations.",
  };
  return clauses[purpose];
}

function getRequiredDocuments(entityType: EntityType): string[][] {
  const docs: Record<string, string[][]> = {
    individual: [
      ["1", "Aadhaar Card (Self-attested copy)"],
      ["2", "PAN Card (Self-attested copy)"],
      ["3", "Passport-size Photograph"],
      ["4", "Cancelled Cheque / Bank Statement"],
    ],
    company: [
      ["1", "Certificate of Incorporation"],
      ["2", "PAN Card of Company"],
      ["3", "GST Registration Certificate (if available)"],
      ["4", "Board Resolution authorizing signatory"],
      ["5", "MOA & AOA"],
      ["6", "Aadhaar & PAN of authorized signatory"],
    ],
    partnership: [
      ["1", "Partnership Deed"],
      ["2", "PAN Card of Firm"],
      ["3", "GST Registration Certificate (if available)"],
      ["4", "Aadhaar & PAN of all partners"],
      ["5", "Authorization letter from all partners"],
    ],
    llp: [
      ["1", "LLP Agreement"],
      ["2", "Certificate of Incorporation (LLP)"],
      ["3", "PAN Card of LLP"],
      ["4", "GST Registration Certificate (if available)"],
      ["5", "Aadhaar & PAN of designated partners"],
      ["6", "Board Resolution authorizing signatory"],
    ],
  };
  return docs[entityType] || docs.individual;
}

// ================================================================
// PDF Generation
// ================================================================

/**
 * Generate the full Leave & License Agreement PDF.
 */
export function generateLeaveLicensePdf(
  variables: LeaveLicenseVariables
): jsPDF {
  const doc = new jsPDF();
  const startY = addBrandHeader(doc);
  const ctx = createPdfContext(doc, startY);

  // ── Title ──
  const titleText = "LEAVE AND LICENSE AGREEMENT";
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(titleText, ctx.pageWidth / 2, ctx.y, { align: "center" });
  ctx.y += 3;

  const titleWidth = doc.getTextWidth(titleText);
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line((ctx.pageWidth - titleWidth) / 2, ctx.y, (ctx.pageWidth + titleWidth) / 2, ctx.y);
  ctx.y += 8;

  // ── Reference & Date ──
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Ref: ${variables.agreement_number}`, ctx.marginLeft, ctx.y);
  doc.text(`Date: ${variables.agreement_date}`, ctx.pageWidth - ctx.marginRight, ctx.y, { align: "right" });
  ctx.y += 10;

  // ── PARTIES ──
  ctx.addWrappedText("PARTIES", ctx.marginLeft, ctx.contentWidth, 11, "bold", BRAND_TEAL, 6);
  ctx.y += 2;

  // Lessor
  ctx.addWrappedText("LESSOR:", ctx.marginLeft, ctx.contentWidth, 9, "bold", BRAND_DARK, 5);
  ctx.addWrappedText(
    `${COMPANY_NAME}, a company incorporated under the Companies Act, having its registered office at ${COMPANY_ADDRESS.join(" ")}, operating under the brand name "${BRAND_NAME}", represented by its Director, ${variables.lessor_signatory_name} (hereinafter referred to as the "Lessor").`,
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 4;

  // Lessee
  ctx.addWrappedText("LESSEE:", ctx.marginLeft, ctx.contentWidth, 9, "bold", BRAND_DARK, 5);
  const lesseeDesc = variables.client_company_name
    ? `${variables.client_company_name}, a ${variables.entity_type_label}, having its registered office at ${variables.client_address}, represented by ${variables.lessee_signatory_name}, ${variables.lessee_signatory_designation} (hereinafter referred to as the "Lessee").`
    : `${variables.client_name}, ${variables.entity_type_label}, residing at ${variables.client_address} (hereinafter referred to as the "Lessee").`;
  ctx.addWrappedText(lesseeDesc, ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5);
  ctx.y += 6;

  // ── RECITALS ──
  ctx.addWrappedText("RECITALS", ctx.marginLeft, ctx.contentWidth, 11, "bold", BRAND_TEAL, 6);
  ctx.y += 2;
  ctx.addWrappedText(
    `WHEREAS the Lessor is the owner/occupier of the premises situated at ${variables.property_address}, operating as "${BRAND_NAME}" (hereinafter referred to as the "Licensed Premises").`,
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 2;
  ctx.addWrappedText(
    getPurposeClause(variables.purpose),
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 2;
  ctx.addWrappedText(
    "NOW THEREFORE, in consideration of the mutual covenants contained herein, the parties agree as follows:",
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── SCHEDULE ──
  ctx.addWrappedText("SCHEDULE", ctx.marginLeft, ctx.contentWidth, 11, "bold", BRAND_TEAL, 6);
  ctx.y += 2;
  ctx.checkPageBreak(40);

  const scheduleData = [
    ["Effective Date", variables.start_date_formatted],
    ["Term", `${variables.tenure_months} months (until ${variables.end_date_formatted})`],
    ["Licensed Premises", `${variables.location_name}, ${variables.property_address}`],
    ["Purpose", variables.purpose_label],
    ["Monthly License Fee", `${variables.rate_formatted} + applicable GST`],
    ["Security Deposit", variables.security_deposit_formatted],
    ["Service Retainer Deposit", `${variables.service_retainer_deposit_formatted} + GST`],
  ];

  autoTable(doc, {
    startY: ctx.y,
    head: [["Item", "Details"]],
    body: scheduleData,
    theme: "grid",
    headStyles: { fillColor: BRAND_TEAL, fontSize: 9, fontStyle: "bold" },
    bodyStyles: { fontSize: 8.5, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 55 } },
    margin: { left: ctx.marginLeft, right: ctx.marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.y = (doc as any).lastAutoTable.finalY + 8;

  // ── TERMS OF USAGE ──
  ctx.addWrappedText("1. TERMS OF USAGE", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;

  const termsOfUsage = [
    "The Lessee shall use the Licensed Premises solely for the stated purpose and shall not engage in any unauthorized or illegal activities.",
    "The Lessee shall not assign, transfer, or sublicense this agreement or any part of the Licensed Premises to any third party.",
    "The Lessee shall maintain confidentiality regarding the terms and conditions of this agreement.",
    "The Lessor shall provide a virtual office address and related facilities as specified in the Schedule.",
    "The Lessee shall comply with all applicable laws, regulations, and statutory requirements.",
    "The Lessee shall indemnify the Lessor against any claims, damages, or liabilities arising from the Lessee's use of the Licensed Premises.",
  ];

  termsOfUsage.forEach((term, i) => {
    ctx.addWrappedText(`${i + 1}.${i + 1} ${term}`, ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5);
    ctx.y += 2;
  });
  ctx.y += 4;

  // ── LICENSE FEES ──
  ctx.addWrappedText("2. LICENSE FEES", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    `The Lessee shall pay a monthly license fee of ${variables.rate_formatted} plus applicable GST, payable on or before the 5th of each month. Any delay in payment shall attract a late payment charge of 2% per month on the outstanding amount.`,
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── SERVICE RETAINER / DEPOSIT ──
  ctx.addWrappedText("3. SERVICE RETAINER / DEPOSIT", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    `The Lessee shall pay a one-time service retainer deposit of ${variables.service_retainer_deposit_formatted} plus applicable GST. Additionally, a security deposit of ${variables.security_deposit_formatted} shall be maintained during the tenure of this agreement. The deposits shall be refundable upon termination, subject to adjustment of any outstanding dues.`,
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── MAIL HANDLING ──
  ctx.addWrappedText("4. MAIL HANDLING", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "The Lessor shall provide mail handling services at the Licensed Premises. Up to 10 letters per month shall be received at no additional charge. Additional letters shall be charged at Rs. 10 per letter and additional packages at Rs. 100 per package. The Lessee shall collect mail during centre operating hours or request forwarding at applicable courier charges.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── TERMINATION ──
  ctx.addWrappedText("5. TERMINATION", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "Either party may terminate this agreement by providing 30 days written notice to the other party. In the event of breach of any terms, the non-breaching party may terminate immediately upon written notice. Upon termination, the Lessee shall cease using the Licensed Premises address and shall update all statutory registrations accordingly within 30 days.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── REFUND POLICY ──
  ctx.addWrappedText("6. REFUND POLICY", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "Upon termination, the security deposit and service retainer shall be refunded within 30 working days, subject to deduction of any outstanding dues, damages, or pending bills. No refund shall be made for unused portions of the license fee paid in advance.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── NATURE OF BUSINESS ──
  ctx.addWrappedText("7. NATURE OF BUSINESS", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    `The Lessee declares that the nature of their business is: ${variables.nature_of_business}. The Lessee shall notify the Lessor in writing of any changes in the nature of business.`,
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── LIABILITY ──
  ctx.addWrappedText("8. LIABILITY", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "The Lessor shall not be liable for any losses, damages, or claims arising from the Lessee's business activities. The Lessee shall indemnify and hold harmless the Lessor from all claims, damages, liabilities, and expenses arising out of the Lessee's use of the Licensed Premises.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── CONFIDENTIALITY ──
  ctx.addWrappedText("9. CONFIDENTIALITY", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "Both parties agree to maintain confidentiality of all information shared during the term of this agreement. Neither party shall disclose the terms, conditions, or any proprietary information to any third party without prior written consent of the other party.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── OWNERSHIP ──
  ctx.addWrappedText("10. OWNERSHIP", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "This agreement does not confer any ownership or leasehold rights upon the Lessee. The Licensed Premises remain the sole property of the Lessor. The Lessee's right is limited to using the address for the purposes stated herein.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── DISPUTE RESOLUTION ──
  ctx.addWrappedText("11. DISPUTE RESOLUTION", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "Any disputes arising under this agreement shall first be resolved through mutual discussion and negotiation. If unresolved within 30 days, the dispute shall be referred to arbitration under the Arbitration and Conciliation Act, 1996. The arbitration shall be conducted in Chennai, Tamil Nadu, and the language of arbitration shall be English.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 6;

  // ── EXECUTION ──
  ctx.addWrappedText("12. EXECUTION", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    "This agreement is executed on the date mentioned above and shall come into effect from the Effective Date mentioned in the Schedule. This agreement is made on e-stamp paper and executed via digital signatures through an authorized e-signing platform.",
    ctx.marginLeft + 4, ctx.contentWidth - 4, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 10;

  // ── ANNEXURE 1: NATURE OF BUSINESS ──
  ctx.checkPageBreak(60);
  ctx.addWrappedText("ANNEXURE 1", ctx.marginLeft, ctx.contentWidth, 11, "bold", BRAND_TEAL, 6);
  ctx.y += 2;

  const annexureData = [
    ["Nature of Business", variables.nature_of_business],
    ["Virtual Office Address", `${variables.location_name}, ${variables.property_address}`],
    ["Lessee Name", variables.client_company_name || variables.client_name],
    ["Contact Person", variables.lessee_signatory_name],
    ["Email", variables.client_email || "—"],
    ["Phone", variables.client_phone || "—"],
  ];

  autoTable(doc, {
    startY: ctx.y,
    body: annexureData,
    theme: "grid",
    bodyStyles: { fontSize: 8.5, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 55 } },
    margin: { left: ctx.marginLeft, right: ctx.marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.y = (doc as any).lastAutoTable.finalY + 8;

  // ── REQUIRED DOCUMENTS ──
  ctx.checkPageBreak(40);
  ctx.addWrappedText("REQUIRED DOCUMENTS", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 2;
  ctx.addWrappedText(
    `Documents required from ${variables.entity_type_label}:`,
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [80, 80, 80], 4.5
  );
  ctx.y += 2;

  const requiredDocs = getRequiredDocuments(variables.client_entity_type);

  autoTable(doc, {
    startY: ctx.y,
    head: [["#", "Document"]],
    body: requiredDocs,
    theme: "grid",
    headStyles: { fillColor: BRAND_TEAL, fontSize: 9, fontStyle: "bold" },
    bodyStyles: { fontSize: 8.5, cellPadding: 3 },
    columnStyles: { 0: { cellWidth: 15, halign: "center" } },
    margin: { left: ctx.marginLeft, right: ctx.marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.y = (doc as any).lastAutoTable.finalY + 10;

  // ── SIGNATURE BLOCK ──
  ctx.checkPageBreak(80);
  ctx.addWrappedText("IN WITNESS WHEREOF, the parties have executed this Leave and License Agreement on the date first written above.", ctx.marginLeft, ctx.contentWidth, 9, "bold", BRAND_DARK, 5);
  ctx.y += 10;

  const colWidth = (ctx.contentWidth - 20) / 2;
  const col1X = ctx.marginLeft;
  const col2X = ctx.marginLeft + colWidth + 20;

  // Signature table
  ctx.checkPageBreak(45);

  autoTable(doc, {
    startY: ctx.y,
    head: [["For the Lessor", "For the Lessee"]],
    body: [
      [
        `Name: ${variables.lessor_signatory_name}\nDesignation: Director\nCompany: ${COMPANY_NAME}`,
        `Name: ${variables.lessee_signatory_name}\nDesignation: ${variables.lessee_signatory_designation || "Authorized Signatory"}\n${variables.client_company_name ? `Company: ${variables.client_company_name}` : ""}`,
      ],
      ["Signature: ____________________", "Signature: ____________________"],
      [`Date: ${variables.agreement_date}`, `Date: ${variables.agreement_date}`],
    ],
    theme: "grid",
    headStyles: { fillColor: BRAND_TEAL, fontSize: 9, fontStyle: "bold" },
    bodyStyles: { fontSize: 8.5, cellPadding: 4, minCellHeight: 12 },
    margin: { left: ctx.marginLeft, right: ctx.marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.y = (doc as any).lastAutoTable.finalY + 10;

  // ── WITNESSES ──
  ctx.checkPageBreak(50);
  ctx.addWrappedText("WITNESSES", ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
  ctx.y += 4;

  const witness1 = variables.witness_1_name || "____________________";
  const witness2 = variables.witness_2_name || "____________________";
  const w1Aadhaar = variables.witness_1_aadhaar_last4 ? `(Aadhaar: XXXX-XXXX-${variables.witness_1_aadhaar_last4})` : "";
  const w2Aadhaar = variables.witness_2_aadhaar_last4 ? `(Aadhaar: XXXX-XXXX-${variables.witness_2_aadhaar_last4})` : "";

  autoTable(doc, {
    startY: ctx.y,
    head: [["Witness 1", "Witness 2"]],
    body: [
      [`Name: ${witness1}`, `Name: ${witness2}`],
      [w1Aadhaar ? `Aadhaar: ${w1Aadhaar}` : "Aadhaar: ____________________", w2Aadhaar ? `Aadhaar: ${w2Aadhaar}` : "Aadhaar: ____________________"],
      ["Signature: ____________________", "Signature: ____________________"],
    ],
    theme: "grid",
    headStyles: { fillColor: [100, 100, 100], fontSize: 9, fontStyle: "bold" },
    bodyStyles: { fontSize: 8.5, cellPadding: 4 },
    margin: { left: ctx.marginLeft, right: ctx.marginRight },
  });

  // ── Footer on all pages ──
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addFooter(doc);
  }

  return doc;
}

// Suppress unused import warnings for autoTable — it attaches to jsPDF prototype
void autoTable;

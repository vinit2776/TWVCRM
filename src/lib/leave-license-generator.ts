/**
 * Leave & License Agreement PDF Generator
 *
 * Generates a full legal Leave & License Agreement matching the authoritative
 * DOCX template ("New VO Agreement Format-1.DOCX").
 * Uses jsPDF with shared branding from pdf-utils.ts.
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { VO_PURPOSE_LABELS, ENTITY_TYPE_LABELS, KYC_DOCUMENTS } from "@/lib/constants";
import {
  BRAND_TEAL,
  BRAND_DARK,
  COMPANY_NAME,
  LL_PROPERTY_ADDRESS,
  LESSOR_DIRECTOR,
  formatCurrency,
  formatDate,
  addBrandHeader,
  addFooter,
  createPdfContext,
} from "@/lib/pdf-utils";
import { drawCompanyStampInBox } from "@/lib/company-stamp";
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
  lessee_signatory_id_label?: string;
  lessee_signatory_id_number?: string;
  nature_of_business: string;
  witness_1_name?: string;
  witness_1_aadhaar_last4?: string;
  witness_1_mobile?: string;
  witness_2_name?: string;
  witness_2_aadhaar_last4?: string;
  witness_2_mobile?: string;
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
  lesseeSignatoryIdType?: 'pan' | 'aadhaar';
  lesseeSignatoryIdNumber?: string;
  witness1Name?: string;
  witness1AadhaarLast4?: string;
  witness1Mobile?: string;
  witness2Name?: string;
  witness2AadhaarLast4?: string;
  witness2Mobile?: string;
  estampValue?: number;
}): LeaveLicenseVariables {
  const startDate = new Date(params.startDate);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + params.tenureMonths);
  endDate.setDate(endDate.getDate() - 1);
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
    lessee_signatory_id_label: params.lesseeSignatoryIdType === "aadhaar" ? "Aadhaar" : "PAN",
    lessee_signatory_id_number: params.lesseeSignatoryIdNumber,
    nature_of_business: params.natureOfBusiness || "To be provided",
    witness_1_name: params.witness1Name,
    witness_1_aadhaar_last4: params.witness1AadhaarLast4,
    witness_1_mobile: params.witness1Mobile,
    witness_2_name: params.witness2Name,
    witness_2_aadhaar_last4: params.witness2AadhaarLast4,
    witness_2_mobile: params.witness2Mobile,
    estamp_value: params.estampValue,
    estamp_value_formatted: params.estampValue ? formatCurrency(params.estampValue) : undefined,
    service_retainer_deposit: serviceRetainer,
    service_retainer_deposit_formatted: formatCurrency(serviceRetainer),
  };
}

// ================================================================
// Purpose-specific clauses
// ================================================================

/** Returns the purpose description for the WHEREAS clause. */
function getPurposeDescription(purpose: VoPurpose): string {
  const descriptions: Record<VoPurpose, string> = {
    gst_registration:
      "solely as the principal address for GST Registration and business correspondence",
    mca_registration:
      "solely as the principal address for Company/LLP Registration with the Ministry of Corporate Affairs (MCA) and business correspondence",
    branch_office:
      "as a branch office address for business operations, GST registration, and business correspondence",
    mail_handling:
      "for receiving business correspondence and mail handling",
    business_address:
      "as a virtual office and professional business address for business operations",
  };
  return descriptions[purpose];
}

/** Returns the purpose-specific text for Terms of Usage clause 2. */
function getTermsOfUsagePurpose(purpose: VoPurpose): string {
  const purposes: Record<VoPurpose, string> = {
    gst_registration:
      "as their principal address for GST Registration",
    mca_registration:
      "as their principal address for Company/LLP Registration with the MCA",
    branch_office:
      "as a branch office address for business operations and GST Registration",
    mail_handling:
      "as their business correspondence address",
    business_address:
      "as their principal business address",
  };
  return purposes[purpose];
}

function getRequiredDocuments(entityType: EntityType): string[][] {
  const docs = KYC_DOCUMENTS[entityType] || KYC_DOCUMENTS.other;
  return docs.map((label, i) => [String(i + 1), label]);
}

// ================================================================
// Lessor registered office address for L&L text (exact DOCX format)
// ================================================================
const LL_LESSOR_REG_OFFICE =
  "'Prakash Presidium' 110, Mahatma Gandhi Road, Nungambakkam, Chennai 600034";

// ================================================================
// PDF Generation
// ================================================================

/**
 * Generate the full Leave & License Agreement PDF.
 * Content matches the authoritative DOCX template exactly.
 */
export function generateLeaveLicensePdf(
  variables: LeaveLicenseVariables,
  options?: { applyCompanyStamp?: boolean; stampRef?: string }
): jsPDF {
  const doc = new jsPDF();
  const startY = addBrandHeader(doc);
  const ctx = createPdfContext(doc, startY);

  // Helper to add a numbered/titled clause heading
  const addClauseHeading = (text: string) => {
    ctx.checkPageBreak(12);
    ctx.addWrappedText(text, ctx.marginLeft, ctx.contentWidth, 10, "bold", BRAND_TEAL, 5.5);
    ctx.y += 2;
  };

  // Helper to add body paragraph text
  const addBodyText = (text: string, indent = 0) => {
    ctx.addWrappedText(
      text,
      ctx.marginLeft + indent,
      ctx.contentWidth - indent,
      9,
      "normal",
      [50, 50, 50],
      4.5
    );
  };

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
  doc.line(
    (ctx.pageWidth - titleWidth) / 2,
    ctx.y,
    (ctx.pageWidth + titleWidth) / 2,
    ctx.y
  );
  ctx.y += 8;

  // ── Reference & Date ──
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Ref: ${variables.agreement_number}`, ctx.marginLeft, ctx.y);
  doc.text(
    `Date: ${variables.agreement_date}`,
    ctx.pageWidth - ctx.marginRight,
    ctx.y,
    { align: "right" }
  );
  ctx.y += 10;

  // ── PARTIES ──
  ctx.addWrappedText(
    "PARTIES",
    ctx.marginLeft,
    ctx.contentWidth,
    11,
    "bold",
    BRAND_TEAL,
    6
  );
  ctx.y += 2;

  // Lessor
  ctx.addWrappedText(
    "LESSOR / SERVICE PROVIDER:",
    ctx.marginLeft,
    ctx.contentWidth,
    9,
    "bold",
    BRAND_DARK,
    5
  );
  ctx.addWrappedText(
    `${COMPANY_NAME}, having registered office address at ${LL_LESSOR_REG_OFFICE}, through its Authorized Signatory, ${variables.lessor_signatory_name}, hereinafter referred to as "Lessor / Service Provider".`,
    ctx.marginLeft,
    ctx.contentWidth,
    9,
    "normal",
    [50, 50, 50],
    4.5
  );
  ctx.y += 4;

  // Lessee
  ctx.addWrappedText(
    "LESSEE / CLIENT:",
    ctx.marginLeft,
    ctx.contentWidth,
    9,
    "bold",
    BRAND_DARK,
    5
  );

  let lesseeDesc: string;
  if (variables.client_company_name) {
    const panText = variables.client_pan_number
      ? `, with PAN Number ${variables.client_pan_number}`
      : "";
    const signatoryIdText = variables.lessee_signatory_id_number
      ? ` (${variables.lessee_signatory_id_label}: ${variables.lessee_signatory_id_number})`
      : "";
    lesseeDesc = `${variables.client_company_name}, through its ${variables.lessee_signatory_designation || "Director"} ${variables.lessee_signatory_name}${signatoryIdText}, having registered office at ${variables.client_address}${panText}, hereinafter referred to as "Lessee/Client". (KYC is attached).`;
  } else {
    const panText = variables.client_pan_number
      ? `, with PAN Number ${variables.client_pan_number}`
      : "";
    lesseeDesc = `${variables.client_name}, residing at ${variables.client_address}${panText}, hereinafter referred to as "Lessee/Client". (KYC is attached).`;
  }
  addBodyText(lesseeDesc);
  ctx.y += 6;

  // ── WHEREAS ──
  ctx.addWrappedText(
    "WHEREAS",
    ctx.marginLeft,
    ctx.contentWidth,
    11,
    "bold",
    BRAND_TEAL,
    6
  );
  ctx.y += 2;

  // Whereas paragraph 1 — Lessor's rights
  addBodyText(
    `The Lessor is the sub leased property owner of the property bearing address: ${variables.location_name}, ${variables.property_address}. The Lessor has full and unfettered rights to lease/let out the said Premises (or a portion thereof) on such terms and conditions as it may think fit at its sole discretion.`
  );
  ctx.y += 3;

  // Whereas paragraph 2 — Lessee's purpose (dynamic)
  addBodyText(
    `The Lessee desires to take a property on lease so as to use the said property ${getPurposeDescription(variables.purpose)} for a period of ${variables.tenure_months} months.`
  );
  ctx.y += 3;

  // Whereas paragraph 3 — Mutual agreement
  addBodyText(
    `Pursuant thereto, the Lessor has agreed to permit the Lessee to use the Licensed Premises on a Leave and License basis, and the Lessee has agreed to take the Licensed Premises on license subject to the terms, covenants, conditions and agreements hereinafter contained.`
  );
  ctx.y += 6;

  // ── EFFECTIVE DATE / TERM / RENEWAL ──
  ctx.checkPageBreak(50);
  ctx.addWrappedText(
    "SCHEDULE",
    ctx.marginLeft,
    ctx.contentWidth,
    11,
    "bold",
    BRAND_TEAL,
    6
  );
  ctx.y += 2;

  const scheduleData = [
    ["Effective Date", variables.start_date_formatted],
    [
      "Term",
      `${variables.tenure_months} Months (until ${variables.end_date_formatted})`,
    ],
    ["Licensed Premises", `${variables.location_name}, ${variables.property_address}`],
    ["Purpose", variables.purpose_label],
    ["License Fee", `${variables.rate_formatted} + applicable GST`],
    ["Security Deposit", variables.security_deposit_formatted],
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
  ctx.y = (doc as any).lastAutoTable.finalY + 6;

  // Renewal clause
  ctx.addWrappedText(
    "Renewal:",
    ctx.marginLeft,
    ctx.contentWidth,
    9,
    "bold",
    BRAND_DARK,
    5
  );
  addBodyText(
    "Following the expiration of the Term mentioned hereinabove, this Agreement may be renewed for a further period as mutually agreed by the parties, on terms and conditions as mutually agreed by the parties. Each renewal term shall be subject to a minimum 5% escalation in License Fees."
  );
  ctx.y += 6;

  // ── USE OF AND ACCESS TO THE LICENSED PREMISES ──
  ctx.checkPageBreak(30);
  addClauseHeading("USE OF AND ACCESS TO THE LICENSED PREMISES");

  addBodyText(
    `The Lessee/Client is interested in using the virtual office space (hereinafter referred to as the "Services") from the Lessor at its premise located at ${variables.location_name}, ${variables.property_address} (hereinafter referred to as the "Premise"). The whole of the Premise remains the property of the Service Provider and remains in the Lessor's possession and control. The allowed usage for Lessor is mentioned in the clause 'Terms of Usage'. This Agreement is personal to the Lessee/Client and cannot be transferred to anyone else. Lessor may transfer the benefit of this Agreement and its obligations under it at any time.`
  );
  ctx.y += 6;

  // ── ACKNOWLEDGMENT AND ACCEPTANCE OF TERMS OF USE ──
  ctx.checkPageBreak(30);
  addClauseHeading("ACKNOWLEDGMENT AND ACCEPTANCE OF TERMS OF USE");

  addBodyText(
    `The Services are offered to Lessee/Clients conditioned on acceptance without modification, of the terms and conditions, contained in this Agreement. Lessee/Client's use of the Service constitutes its agreement and consent to the terms and conditions stated in this Agreement. Each person that uses the Premise, or enters into a contract, in writing or online, on behalf of its employer or other third party, represents that such person is authorized to accept these terms on its employer's or on third party's behalf. Unless explicitly stated otherwise, the Terms of Service will govern the use of any new features that augment or enhance the current Services, including the release of new resources and services. In the case of any violation of these terms, Service Provider reserves the right to cancel Services to Lessee/Client immediately and seek all remedies available by law and in equity for such violations.`
  );
  ctx.y += 6;

  // ── 1. TERMS OF USAGE ──
  addClauseHeading("1. TERMS OF USAGE");

  const termsOfUsage = [
    "The Lessee/Client may use the address for its business correspondence.",
    `The Lessee/Client is only permitted to use the Office Address prescribed herein ${getTermsOfUsagePurpose(variables.purpose)}, provided that the Lessee/Client bears the responsibility for compliance with all the necessary provisions of the law including the Companies Act, GST Laws, etc.`,
    "The Lessee/Client hereby agrees to maintain the books of accounts at the space allotted to it in the Premises. Non-compliance with respect to non-maintenance of books of accounts shall be on the Lessee/Client.",
    "The Lessee/Client is not allowed to use the Office Address or the address of the Premises as the primary bodies. The Lessee/Client shall seek prior written permission from the Service Provider/Lessor if it wishes to utilise the office address for any statutory / Government purpose including but not limited to address in MCA records.",
    "The Lessee/Client is not allowed to avail any credit facility, whether relating to any loans or any other forms of credit line, on this address.",
    "The Lessee agrees that no trade or occupation shall be conducted using the address of the Premises which will be unlawful, improper, or contrary to any law, ordinance, by-law, code, rule, regulation or order applicable or which will tarnish or cause harm or injury to the reputation of the Lessor and/or the Premises.",
    "The Lessee/Client understands that this Leave and License Agreement is contingent upon the Lessee/Client's strict adherence to the Terms of Usage prescribed herein and any contravention of the Terms of Usage prescribed hereinabove by the Lessee/Client would constitute a material breach of this Agreement and thereby liable to immediate termination of the Agreement. The Service Provider/Lessor shall also be entitled to all the remedies available to it in law in addition to such termination of this Agreement.",
  ];

  termsOfUsage.forEach((term, i) => {
    ctx.checkPageBreak(15);
    ctx.addWrappedText(
      `1.${i + 1} ${term}`,
      ctx.marginLeft + 4,
      ctx.contentWidth - 4,
      9,
      "normal",
      [50, 50, 50],
      4.5
    );
    ctx.y += 2;
  });
  ctx.y += 4;

  // ── 2. LICENSE FEES ──
  addClauseHeading("2. LICENSE FEES");
  addBodyText(
    `License fees of ${variables.rate_formatted} + applicable GST is payable in advance by the Client/Lessee to the Service Provider/Lessor. Any dues/delays in the License fees in case of renewals will cause the termination of the Services/Agreement on the expiration date set forth at the time of signup or payment. For late payments of renewals, the client has to pay an additional 5% penalty per day, in addition to the renewal license fees, for delay in payment.`
  );
  ctx.y += 6;

  // ── 3. SERVICE RETAINER / DEPOSIT AMOUNT ──
  addClauseHeading("3. SERVICE RETAINER / DEPOSIT AMOUNT");
  addBodyText(
    `At any time during the subsistence of this Agreement, the Client can opt to use the "Courier Forwarding" facility from the Service Provider, for which the Client will be required to pay a Service Retainer / Deposit Amount of ${variables.service_retainer_deposit_formatted} + GST. This amount will be kept separately from License fees. Client has to replenish the deposit when it reaches Rs. 250. When the Client terminates the Service, the balance of the Service Retainer / Deposit Amount, if any, will be refunded to the Client.`
  );
  if (variables.security_deposit > 0) {
    ctx.y += 2;
    addBodyText(
      `Additionally, a Security Deposit of ${variables.security_deposit_formatted} is payable and shall be maintained during the tenure of this Agreement.`
    );
  }
  ctx.y += 6;

  // ── 4. MAIL HANDLING ──
  addClauseHeading("4. MAIL HANDLING");
  addBodyText(
    "Client can receive registered and certified mail at the Premise. Service Provider will receive up to 10 letters or packages per month free of charge for the Client. For additional letters or packages, Service Provider will charge a handling fee of Rs. 10 per letter / Rs. 100 per package. Service Provider will not accept packages more than 5 Kg of weight or 1 cubic feet size. Client can pick up the mails from the Premises free of cost. Service Provider shall not be liable for any mail/package not collected by the Client within 30 days from the date of receipt of the mail/package by the Service Provider at the Premise."
  );
  ctx.y += 6;

  // ── 5. TERMINATION OF SERVICE ──
  addClauseHeading("5. TERMINATION OF SERVICE");
  addBodyText(
    "Service will be automatically terminated on the expiry of the Term unless the license is renewed. Upon termination of this Agreement, the Client must cease the use of address of the Premise absolutely, including for any government registrations, and further, any Phone Numbers issued by the Service Provider to the Client shall also be ceased to be used immediately by the Client."
  );
  ctx.y += 2;
  addBodyText(
    "The Client shall remove the said address and phone numbers from all places including but not limited to GST records, MCA records (if applicable), business cards, websites, stationery, advertising material, licenses, certificates etc."
  );
  ctx.y += 2;
  addBodyText(
    "Notwithstanding any other provision under this Agreement, if the Client has used the address of the premise for registration with the registrar of companies, GST Authority, Banks, or other governmental authorities etc., it has to change the address submitted with such authorities within 15 (Fifteen) days from the date of termination or expiry of this Agreement, unless otherwise agreed in writing by Service Provider."
  );
  ctx.y += 2;
  addBodyText(
    "The Lessor reserves the right to take legal action against the Lessee if the Lessee is found in breach of this clause. Service Provider reserves the right to terminate the Service and this Agreement without notice if the Client's activity might adversely affect the Service Provider's reputation or Service Provider's normal operation."
  );
  ctx.y += 2;
  addBodyText(
    "Service Provider will terminate the Service anytime in case Client violates any clause or provision of this Agreement, or Client's activities are reported to be fraudulent, illegal or offensive in nature, attracting criminal consequences. In such eventuality, the Service Provider shall be entitled to withhold the entire Service Retainer / Deposit Amount in hand in addition to being entitled to receive liquidated damages of Rs. 5,00,000/- from the Client for the damage caused to the reputation and goodwill of the Service Provider."
  );
  ctx.y += 6;

  // ── 6. REFUND POLICY ──
  addClauseHeading("6. REFUND POLICY");
  addBodyText(
    "Any License fee paid fully or partially is non-refundable, unless the Lessor terminates the Agreement without cause."
  );
  ctx.y += 6;

  // ── 7. NATURE OF BUSINESS ──
  addClauseHeading("7. NATURE OF BUSINESS");
  addBodyText(
    `The Lessee/Client has to explain its nature of business in writing on this Agreement in Annexure 1 hereto. The Lessee/Client agrees with the Service Provider not to carry on any business, which could be construed illegal, defamatory, immoral or obscene and agrees not to use the address of the premises, whether directly or indirectly for any such purpose or purposes.`
  );
  ctx.y += 2;
  addBodyText(
    `If the Lessee/Client carries any business contrary to this understanding, the Service Provider is at liberty to terminate the Agreement and shall not be responsible for any legal issues which may arise because of such illegal business. Further the Service Provider shall be entitled to damages as mentioned supra in the clause pertaining to "Termination of Service".`
  );
  ctx.y += 2;
  addBodyText(
    "If the Lessee/Client changes the nature of business, it must notify the Service Provider in writing beforehand."
  );
  ctx.y += 2;
  addBodyText(
    `Nature of Business declared: ${variables.nature_of_business}`
  );
  ctx.y += 6;

  // ── 8. LIABILITY ──
  addClauseHeading("8. LIABILITY");
  addBodyText(
    "Service Provider will not be liable for any loss sustained as a result of Service Provider's failure to provide the services as a result of any Software Glitches, Mechanical breakdown, Strike, Loss of electric power, or termination of Service Provider interest in the building containing the office. The Service Provider does not accept liability for actions, services of/by third parties in any way whatsoever, including delays & non-receipt of messages or communication due to delays or failures in the email, SMS or fax systems, Phone, courier or postal service."
  );
  ctx.y += 2;
  addBodyText(
    "Further, Service Provider shall not be responsible or liable to Lessee/Client for any loss or damage resulting to Lessee/Client by reason including but not limited to flood, fire, hurricane, riots, explosion, acts of God, war, terror, governmental action, or any other cause which is beyond the reasonable control of the Service Provider."
  );
  ctx.y += 2;
  addBodyText(
    "The Client shall indemnify and keep and hold Service Provider fully indemnified and harmless from and against all claims, proceedings, damages, losses, actions, costs and expenses arising as a consequence of or out of this Agreement or arising from its breach of any rules and regulations of any applicable law."
  );
  ctx.y += 2;
  addBodyText(
    "In case the Client is unable to fulfill the obligations mentioned herein, this Agreement shall be deemed to be terminated therefrom."
  );
  ctx.y += 2;
  addBodyText(
    "In the event of termination of this Agreement, the Client shall forthwith cease the use of address of the Premises for any purposes. In the event of a violation, the Client is liable to compensate the Service Provider a sum equivalent to three times the agreed License fee as damages until the cessation and rectification of such violation."
  );
  ctx.y += 6;

  // ── 9. CONFIDENTIALITY ──
  addClauseHeading("9. CONFIDENTIALITY");
  addBodyText(
    `Client recognizes that it may, in the course of obtaining or using the Services, come into possession of or learn certain confidential information ("Confidential Information") about Service Provider. Client agrees that during the Term of this Agreement and thereafter: (a) Client shall provide, at a minimum, the care to avoid disclosure of and/or unauthorized use of Confidential Information as it would provide to its own confidential information, but in no event less than a reasonable standard of care; (b) Client will use Confidential Information solely for the purposes of this Agreement; and (c) Client will not disclose Confidential Information to any third party without the express prior written consent of Service Provider, unless required to do so under applicable law.`
  );
  ctx.y += 2;
  addBodyText(
    "Similarly, the Service Provider recognizes that it may, in the course of obtaining or using the Services, come into possession of or learn confidential and proprietary business information (\"Confidential Information\") about the Lessee/Client. Service Provider agrees that during the Term of this Agreement and thereafter Service Provider shall provide, at a minimum, the care to avoid disclosure of and/or unauthorized use of Confidential Information of Lessee/Client."
  );
  ctx.y += 2;
  addBodyText(
    "If the Service Provider transfers its business or any business segment that provides services to the Lessee/Client, Service Provider is authorized to transfer all user information to Service Provider's successor."
  );
  ctx.y += 6;

  // ── 10. OWNERSHIP ──
  addClauseHeading("10. OWNERSHIP");
  addBodyText(
    "All programs, services, processes, designs, software, technologies, trademarks, trade names, inventions and materials comprising the services are wholly owned by the Service Provider and/or its Lessors and service providers except where expressly stated otherwise. This Agreement only provides a license to the Lessee/Client to use the address of the Premise and will not provide any leasehold rights to the Lessee/Client."
  );
  ctx.y += 2;
  addBodyText(
    "Lessee/Client agrees that the Lessee/Client is not the owner of any phone number assigned to them by the Service Provider. Upon termination of the Agreement for any reason, such number may be reassigned to another Lessee/Client."
  );
  ctx.y += 6;

  // ── REQUIRED DOCUMENTS ──
  ctx.checkPageBreak(40);
  addClauseHeading("REQUIRED DOCUMENTS");
  addBodyText(
    `Documents required from ${variables.entity_type_label}:`
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
  ctx.y = (doc as any).lastAutoTable.finalY + 8;

  // ── DISPUTE RESOLUTION ──
  ctx.checkPageBreak(30);
  addClauseHeading("DISPUTE RESOLUTION");
  addBodyText(
    "Any dispute, controversy or difference which may arise between the parties out of or in relation to or in connection with the Agreement, shall be referred to a Sole Arbitrator to be appointed mutually by the Parties. The arbitral proceedings shall be conducted in English language and the Venue of arbitration shall be at Chennai."
  );
  ctx.y += 2;
  addBodyText(
    "The arbitral tribunal shall follow the Fastrack procedure as laid down under section 29B (2) of the Arbitration and Conciliation Act, 1996, while conducting the arbitration proceedings. The award of the arbitrator shall be made within a period of 6 months from the date arbitral tribunal enters upon the reference. The fee payable to the arbitrator shall be in accordance with the Schedule IV of the Arbitration and Conciliation Act, 1996."
  );
  ctx.y += 6;

  // ── EXECUTION BY PARTIES ──
  ctx.checkPageBreak(20);
  addClauseHeading("EXECUTION BY PARTIES");
  addBodyText(
    "The parties acknowledge that electronic signatures and electronically transmitted signatures shall be legally binding with the same effect as if such signatures were originals."
  );
  ctx.y += 10;

  // ── ANNEXURE 1 ──
  ctx.checkPageBreak(60);
  ctx.addWrappedText(
    "ANNEXURE 1",
    ctx.marginLeft,
    ctx.contentWidth,
    11,
    "bold",
    BRAND_TEAL,
    6
  );
  ctx.y += 2;

  const annexureData = [
    [
      "Brief about Company Operations",
      variables.nature_of_business,
    ],
    [
      "Client's Address (\"Office Address\")",
      `${variables.location_name}, ${variables.property_address}`,
    ],
    [
      "Lessee/Client Name",
      variables.client_company_name || variables.client_name,
    ],
    ["Contact Person", variables.lessee_signatory_name],
    ["Email", variables.client_email || "—"],
    ["Phone", variables.client_phone || "—"],
  ];

  autoTable(doc, {
    startY: ctx.y,
    body: annexureData,
    theme: "grid",
    bodyStyles: { fontSize: 8.5, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 60 } },
    margin: { left: ctx.marginLeft, right: ctx.marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.y = (doc as any).lastAutoTable.finalY + 10;

  // ── SIGNATURE BLOCK ──
  ctx.checkPageBreak(80);
  ctx.addWrappedText(
    "IN WITNESS WHEREOF, the parties hereto have executed this instrument under seal as of the date set forth above.",
    ctx.marginLeft,
    ctx.contentWidth,
    9,
    "bold",
    BRAND_DARK,
    5
  );
  ctx.y += 10;

  ctx.checkPageBreak(45);

  let lessorSignatureCell: { x: number; y: number; width: number; height: number } | null = null;

  autoTable(doc, {
    startY: ctx.y,
    head: [["For Lessor", "For Lessee"]],
    body: [
      [
        "Signature: ____________________",
        "Signature: ____________________",
      ],
      [
        `Name: ${variables.lessor_signatory_name.toUpperCase()}`,
        `Name: ${variables.lessee_signatory_name}`,
      ],
      [
        "Designation/Title: Director",
        `Designation/Title: ${variables.lessee_signatory_designation || "Director"}`,
      ],
      ...(variables.lessee_signatory_id_number
        ? [["", `${variables.lessee_signatory_id_label}: ${variables.lessee_signatory_id_number}`]]
        : []),
      [
        `Date: ${variables.agreement_date}`,
        `Date: ${variables.agreement_date}`,
      ],
    ],
    theme: "grid",
    headStyles: { fillColor: BRAND_TEAL, fontSize: 9, fontStyle: "bold" },
    bodyStyles: { fontSize: 8.5, cellPadding: 4, minCellHeight: 12 },
    margin: { left: ctx.marginLeft, right: ctx.marginRight },
    didParseCell: (data) => {
      if (options?.applyCompanyStamp && data.section === "body" && data.row.index === 0) {
        data.cell.styles.minCellHeight = 26;
      }
    },
    didDrawCell: (data) => {
      if (options?.applyCompanyStamp && data.section === "body" && data.row.index === 0 && data.column.index === 0) {
        lessorSignatureCell = { x: data.cell.x, y: data.cell.y, width: data.cell.width, height: data.cell.height };
      }
    },
  });

  if (lessorSignatureCell) {
    drawCompanyStampInBox(doc, lessorSignatureCell, options?.stampRef);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.y = (doc as any).lastAutoTable.finalY + 10;

  // ── WITNESSES ──
  ctx.checkPageBreak(50);
  ctx.addWrappedText(
    "WITNESSES",
    ctx.marginLeft,
    ctx.contentWidth,
    10,
    "bold",
    BRAND_TEAL,
    5.5
  );
  ctx.y += 4;

  const witness1 = variables.witness_1_name || "____________________";
  const witness2 = variables.witness_2_name || "____________________";
  const w1Aadhaar = variables.witness_1_aadhaar_last4
    ? `XXXX-XXXX-${variables.witness_1_aadhaar_last4}`
    : "____________________";
  const w2Aadhaar = variables.witness_2_aadhaar_last4
    ? `XXXX-XXXX-${variables.witness_2_aadhaar_last4}`
    : "____________________";
  const w1Mobile = variables.witness_1_mobile || "____________________";
  const w2Mobile = variables.witness_2_mobile || "____________________";

  autoTable(doc, {
    startY: ctx.y,
    head: [["WITNESS 1", "WITNESS 2"]],
    body: [
      [`Name: ${witness1}`, `Name: ${witness2}`],
      [
        `Aadhar Number: ${w1Aadhaar}`,
        `Aadhar Number: ${w2Aadhaar}`,
      ],
      [
        `Aadhar Linked Mobile No: ${w1Mobile}`,
        `Aadhar Linked Mobile No: ${w2Mobile}`,
      ],
      [
        "Signature: ____________________",
        "Signature: ____________________",
      ],
    ],
    theme: "grid",
    headStyles: {
      fillColor: [100, 100, 100],
      fontSize: 9,
      fontStyle: "bold",
    },
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

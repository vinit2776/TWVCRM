/**
 * Addendum PDF Generator
 *
 * Generates a branded addendum document for contract renewals.
 * The addendum references the original agreement and captures the
 * negotiated renewal terms (escalation, tenure, seats, etc.)
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  BRAND_TEAL,
  BRAND_DARK,
  COMPANY_NAME,
  BRAND_NAME,
  COMPANY_ADDRESS,
  COMPANY_PHONE,
  COMPANY_WEBSITE,
  COMPANY_GST,
  formatCurrency,
  formatDate,
  addBrandHeader,
  addFooter,
  createPdfContext,
} from "@/lib/pdf-utils";

export interface AddendumData {
  // Renewal (new) contract
  renewal_contract_number: string;
  renewal_start_date: string;
  renewal_end_date: string;
  renewal_tenure_months: number;
  renewal_subtotal: number;
  renewal_total_amount: number;
  renewal_tax_percentage: number;
  renewal_tax_amount: number;
  renewal_escalation_percentage: number;
  renewal_escalation_waived: boolean;
  renewal_seats: number;
  renewal_billing_cycle: string;
  renewal_sequence: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renewal_items: { description: string; quantity: number; unit_price: number; total: number }[];

  // Parent (original) contract
  parent_contract_number: string;
  parent_start_date: string;
  parent_end_date: string;
  parent_subtotal: number;
  parent_seats: number;
  parent_tenure_months: number;
  parent_agreement_date?: string;

  // Client details
  client_name: string; // Company or individual name
  client_contact_person?: string;
  client_designation?: string;
  client_pan?: string;
  client_address?: string;

  // Workspace
  workspace_description?: string;
  location_name?: string;
  location_address?: string;

  // Dates
  addendum_date: string; // Date of this addendum
}

const BILLING_CYCLE_WORDS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-Yearly",
  yearly: "Yearly",
};

function numberToWords(num: number): string {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  if (num === 0) return "Zero";
  if (num < 0) return "Minus " + numberToWords(-num);

  let words = "";
  if (Math.floor(num / 10000000) > 0) { words += numberToWords(Math.floor(num / 10000000)) + " Crore "; num %= 10000000; }
  if (Math.floor(num / 100000) > 0) { words += numberToWords(Math.floor(num / 100000)) + " Lakh "; num %= 100000; }
  if (Math.floor(num / 1000) > 0) { words += numberToWords(Math.floor(num / 1000)) + " Thousand "; num %= 1000; }
  if (Math.floor(num / 100) > 0) { words += ones[Math.floor(num / 100)] + " Hundred "; num %= 100; }
  if (num > 0) {
    if (words !== "") words += "and ";
    if (num < 20) words += ones[num];
    else { words += tens[Math.floor(num / 10)]; if (num % 10 > 0) words += "-" + ones[num % 10]; }
  }
  return words.trim();
}

export function generateAddendumPdf(data: AddendumData): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _ = autoTable; // Ensure autoTable is loaded

  // ── Page 1: Header ──
  let startY = addBrandHeader(doc);
  const ctx = createPdfContext(doc, startY);

  const addendumSeq = data.renewal_sequence - 1;
  const addendumLabel = addendumSeq > 0 ? `ADDENDUM ${addendumSeq}` : "ADDENDUM";

  // ── Title ──
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(`${addendumLabel} — FACILITIES SERVICES AGREEMENT`, doc.internal.pageSize.getWidth() / 2, ctx.y, { align: "center" });
  ctx.y += 8;

  // ── Reference line ──
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  doc.text(`Ref: ${data.renewal_contract_number}  |  Date: ${formatDate(data.addendum_date)}`, doc.internal.pageSize.getWidth() / 2, ctx.y, { align: "center" });
  ctx.y += 10;

  // ── Preamble ──
  const agreementDateStr = data.parent_agreement_date ? formatDate(data.parent_agreement_date) : formatDate(data.parent_start_date);

  ctx.addWrappedText(
    `This Addendum to the Facilities Services Agreement ("Agreement") bearing reference ${data.parent_contract_number}, dated ${agreementDateStr}, hereby amends the Agreement entered into by and between:`,
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 4;

  // ── Party 1 ──
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("PARTY 1 (Service Provider):", ctx.marginLeft, ctx.y);
  ctx.y += 5;
  ctx.addWrappedText(
    `${COMPANY_NAME}, operating as "${BRAND_NAME}", having its registered office at ${COMPANY_ADDRESS.join(" ")} (hereinafter referred to as the "Service Provider").`,
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 4;

  // ── Party 2 ──
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("PARTY 2 (Client):", ctx.marginLeft, ctx.y);
  ctx.y += 5;
  const clientDesc = [
    data.client_name,
    data.client_contact_person ? `represented by ${data.client_contact_person}${data.client_designation ? `, ${data.client_designation}` : ""}` : "",
    data.client_pan ? `(PAN: ${data.client_pan})` : "",
    data.client_address ? `having address at ${data.client_address}` : "",
  ].filter(Boolean).join(", ");
  ctx.addWrappedText(
    `${clientDesc} (hereinafter referred to as the "Client").`,
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 4;

  // ── Location ──
  if (data.location_name || data.workspace_description) {
    ctx.addWrappedText(
      `For the leased property: ${[data.workspace_description, data.location_name, data.location_address].filter(Boolean).join(", ")}.`,
      ctx.marginLeft, ctx.contentWidth, 9, "italic", [80, 80, 80], 4.5
    );
    ctx.y += 4;
  }

  // ── Recitals ──
  ctx.addWrappedText(
    'The Client and the Service Provider are collectively referred to hereinafter as the "Parties". Capitalised terms not defined herein shall have the meaning ascribed to them in the Agreement.',
    ctx.marginLeft, ctx.contentWidth, 8.5, "normal", [70, 70, 70], 4.2
  );
  ctx.y += 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("WITNESSETH:", ctx.marginLeft, ctx.y);
  ctx.y += 6;

  ctx.addWrappedText("WHEREAS, the Parties hereto are currently working together pursuant to the Agreement;", ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5);
  ctx.y += 3;
  ctx.addWrappedText("WHEREAS, the Parties mutually agree to amend certain terms of the Agreement in the manner set forth herein.", ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5);
  ctx.y += 3;
  ctx.addWrappedText("NOW, THEREFORE, in consideration of the above premises and the mutual promises contained herein, it is hereby agreed that the Agreement shall be and hereby is modified and amended as follows:", ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5);
  ctx.y += 8;

  // ── Amendments ──
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("AMENDMENTS", ctx.marginLeft, ctx.y);
  ctx.y += 7;

  let clauseNum = 1;

  // Clause 1: Tenure extension
  ctx.checkPageBreak(15);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Extension of Term", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;
  ctx.addWrappedText(
    `The Parties agree that the Agreement shall be extended for a further period of ${data.renewal_tenure_months} (${numberToWords(data.renewal_tenure_months).toLowerCase()}) months, commencing from ${formatDate(data.renewal_start_date)} and ending on ${formatDate(data.renewal_end_date)}.`,
    ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 5;
  clauseNum++;

  // Clause 2: Revised service fee
  ctx.checkPageBreak(20);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Revised Service Fee", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;

  if (data.renewal_escalation_waived) {
    ctx.addWrappedText(
      `The Parties agree that the escalation has been waived for this renewal period. The monthly service fee shall remain at INR ${formatCurrency(data.renewal_subtotal).replace("Rs. ", "")} (Rupees ${numberToWords(Math.round(data.renewal_subtotal))} Only), the same as the previous term.`,
      ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
    );
  } else {
    ctx.addWrappedText(
      `The Parties agree that the existing monthly service fee of INR ${formatCurrency(data.parent_subtotal).replace("Rs. ", "")} shall be escalated by ${data.renewal_escalation_percentage}% to INR ${formatCurrency(data.renewal_subtotal).replace("Rs. ", "")} (Rupees ${numberToWords(Math.round(data.renewal_subtotal))} Only) w.e.f. ${formatDate(data.renewal_start_date)}.`,
      ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
    );
  }
  ctx.y += 5;
  clauseNum++;

  // Clause 3: Seats (if changed)
  if (data.renewal_seats !== data.parent_seats) {
    ctx.checkPageBreak(15);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_DARK);
    doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
    doc.text("Revised Seating Capacity", ctx.marginLeft + 6, ctx.y);
    ctx.y += 5;
    ctx.addWrappedText(
      `The allocated seating capacity shall be revised from ${data.parent_seats} seat(s) to ${data.renewal_seats} seat(s) effective ${formatDate(data.renewal_start_date)}. Any security deposit differential arising from this change shall be settled separately.`,
      ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
    );
    ctx.y += 5;
    clauseNum++;
  }

  // ── Fee Schedule Table ──
  ctx.checkPageBreak(30);
  ctx.y += 2;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Schedule of Revised Fees", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;
  clauseNum++;

  const tableBody = data.renewal_items.map((item, idx) => [
    String(idx + 1),
    item.description,
    String(item.quantity),
    formatCurrency(item.unit_price),
    formatCurrency(item.total),
  ]);
  tableBody.push(["", "", "", "Subtotal", formatCurrency(data.renewal_subtotal)]);
  if (data.renewal_tax_percentage > 0) {
    tableBody.push(["", "", "", `GST @ ${data.renewal_tax_percentage}%`, formatCurrency(data.renewal_tax_amount)]);
  }
  tableBody.push(["", "", "", "Total (incl. tax)", formatCurrency(data.renewal_total_amount)]);

  autoTable(doc, {
    startY: ctx.y,
    margin: { left: ctx.marginLeft + 6, right: ctx.marginRight },
    head: [["#", "Description", "Qty", "Unit Price", "Amount"]],
    body: tableBody,
    theme: "grid",
    headStyles: {
      fillColor: BRAND_TEAL,
      textColor: [255, 255, 255],
      fontSize: 8,
      fontStyle: "bold",
    },
    bodyStyles: { fontSize: 8, textColor: [50, 50, 50] },
    columnStyles: {
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 15, halign: "center" },
      3: { cellWidth: 30, halign: "right" },
      4: { cellWidth: 30, halign: "right" },
    },
    didParseCell: (hookData) => {
      const row = hookData.row.index;
      const totalRows = tableBody.length;
      if (row >= totalRows - (data.renewal_tax_percentage > 0 ? 3 : 2)) {
        hookData.cell.styles.fontStyle = "bold";
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.y = (doc as any).lastAutoTable.finalY + 5;

  // Billing cycle
  ctx.addWrappedText(
    `Billing Cycle: ${BILLING_CYCLE_WORDS[data.renewal_billing_cycle] || data.renewal_billing_cycle}`,
    ctx.marginLeft + 6, ctx.contentWidth - 6, 8.5, "italic", [80, 80, 80], 4.5
  );
  ctx.y += 6;

  // ── Continuing clauses ──
  ctx.checkPageBreak(15);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Continuation of Terms", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;
  ctx.addWrappedText(
    "All other terms and conditions of the Agreement, including but not limited to confidentiality, indemnification, insurance, dispute resolution, and facility usage policies, shall remain in full force and effect and shall apply to the extended term.",
    ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 5;
  clauseNum++;

  // Clause: Precedence
  ctx.checkPageBreak(15);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Precedence", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;
  ctx.addWrappedText(
    "This Addendum amends the Agreement only to the extent expressly stated herein. In the event of a conflict between the terms of this Addendum and those contained within the Agreement, the terms of this Addendum shall prevail.",
    ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 5;
  clauseNum++;

  // Clause: Governing Law
  ctx.checkPageBreak(15);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Governing Law & Jurisdiction", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;
  ctx.addWrappedText(
    "This Addendum shall be governed by and construed in accordance with the laws of India. Any disputes arising out of or in connection with this Addendum shall be subject to the exclusive jurisdiction of the courts of Chennai, Tamil Nadu.",
    ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 5;
  clauseNum++;

  // Clause: Amendments to Law
  ctx.checkPageBreak(15);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Amendments to Applicable Law", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;
  ctx.addWrappedText(
    "In the event of any change in applicable law, regulation, or government notification that affects the rights or obligations of either Party under the Agreement or this Addendum, the Parties shall negotiate in good faith to amend the relevant terms accordingly. Any such amendment shall be documented in a supplementary addendum signed by both Parties.",
    ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 5;
  clauseNum++;

  // Clause: Force Majeure
  ctx.checkPageBreak(15);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${clauseNum}.`, ctx.marginLeft, ctx.y);
  doc.text("Force Majeure", ctx.marginLeft + 6, ctx.y);
  ctx.y += 5;
  ctx.addWrappedText(
    "Neither Party shall be liable for any failure or delay in performing its obligations under this Addendum if such failure or delay results from circumstances beyond the reasonable control of the affected Party, including but not limited to natural disasters, pandemics, government actions, wars, or civil unrest. The affected Party shall promptly notify the other Party in writing and the Parties shall negotiate an equitable adjustment.",
    ctx.marginLeft + 6, ctx.contentWidth - 6, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 8;

  // ── Entire Agreement ──
  ctx.checkPageBreak(20);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("ENTIRE AGREEMENT", ctx.marginLeft, ctx.y);
  ctx.y += 6;
  ctx.addWrappedText(
    "This Addendum, together with the Agreement of which it is a part, constitutes the complete and exclusive statement of the agreement between the Parties, which supersedes all prior or concurrent proposals and understandings, whether oral or written, relating to the subject matter herein.",
    ctx.marginLeft, ctx.contentWidth, 9, "normal", [50, 50, 50], 4.5
  );
  ctx.y += 8;

  // ── Witness clause ──
  ctx.checkPageBreak(15);
  ctx.addWrappedText(
    "IN WITNESS WHEREOF, the undersigned have executed this Addendum to the Agreement as of the date first written above.",
    ctx.marginLeft, ctx.contentWidth, 9, "bold", BRAND_DARK, 4.5
  );
  ctx.y += 4;
  ctx.addWrappedText(
    "We, Service Provider and Client, agree to the aforementioned amendments. Any changes made are legally binding upon signature of both Parties.",
    ctx.marginLeft, ctx.contentWidth, 8.5, "normal", [80, 80, 80], 4.5
  );
  ctx.y += 12;

  // ── Signature blocks ──
  ctx.checkPageBreak(40);
  const halfWidth = ctx.contentWidth / 2 - 5;

  // Service Provider
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("For the Service Provider", ctx.marginLeft, ctx.y);
  doc.text("For the Client", ctx.marginLeft + halfWidth + 10, ctx.y);
  ctx.y += 6;

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(BRAND_NAME, ctx.marginLeft, ctx.y);
  doc.text(data.client_name, ctx.marginLeft + halfWidth + 10, ctx.y);
  ctx.y += 4;
  doc.text(COMPANY_NAME, ctx.marginLeft, ctx.y);
  if (data.client_contact_person) {
    doc.text(data.client_contact_person, ctx.marginLeft + halfWidth + 10, ctx.y);
  }
  ctx.y += 15;

  // Signature lines
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.3);
  doc.line(ctx.marginLeft, ctx.y, ctx.marginLeft + halfWidth, ctx.y);
  doc.line(ctx.marginLeft + halfWidth + 10, ctx.y, ctx.marginLeft + halfWidth * 2 + 10, ctx.y);
  ctx.y += 4;

  doc.setFontSize(7.5);
  doc.setTextColor(120, 120, 120);
  doc.text("Authorised Signatory", ctx.marginLeft, ctx.y);
  doc.text("Authorised Signatory", ctx.marginLeft + halfWidth + 10, ctx.y);
  ctx.y += 5;

  // Date lines
  doc.text(`Date: ${formatDate(data.addendum_date)}`, ctx.marginLeft, ctx.y);
  doc.text("Date: _______________", ctx.marginLeft + halfWidth + 10, ctx.y);
  ctx.y += 8;

  // ── GST info ──
  doc.setFontSize(7);
  doc.setTextColor(140, 140, 140);
  doc.text(COMPANY_GST, ctx.marginLeft, ctx.y);

  // ── Footer ──
  addFooter(doc);

  return doc;
}

import jsPDF from "jspdf";
import QRCode from "qrcode";
import { BRAND_DARK, BRAND_TEAL, addBrandHeader, addFooter, formatCurrency, formatDate } from "@/lib/pdf-utils";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

export interface DepositRequestPdfInput {
  proposal_number: string;
  amount: number;
  security_deposit_months: number;
  customer_name: string;
  company: string | null;
  customer_message: string;
  deposit_link_url: string | null;
  due_date: string;
}

// jsPDF's built-in Helvetica is Latin-1 only; anything outside it (₹, smart
// quotes pasted from WhatsApp) breaks line-width maths for the whole line.
function sanitize(text: string): string {
  return text
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x00-\xFF]/g, "");
}

/**
 * One-page security deposit request, mirroring the deposit email, for the team
 * to share with a customer by hand (WhatsApp, their own inbox) when the email
 * from the CRM isn't enough.
 */
export async function generateDepositRequestPDF(input: DepositRequestPdfInput): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pw = doc.internal.pageSize.getWidth();
  const left = 15;
  const right = pw - 15;
  const width = right - left;
  let y = addBrandHeader(doc);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Security Deposit Request", left, y);
  y += 10;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_DARK);
  const addressee = input.company ? `${input.customer_name}, ${input.company}` : input.customer_name;
  doc.text(sanitize(`Dear ${addressee || "Customer"},`), left, y);
  y += 7;

  const intro = doc.splitTextToSize(
    sanitize(
      `Thank you for accepting our proposal ${input.proposal_number}. To proceed with the contract, please pay the refundable security deposit of ${input.security_deposit_months} month(s).`
    ),
    width
  );
  doc.text(intro, left, y);
  y += intro.length * 5 + 3;

  if (input.customer_message) {
    const msg = doc.splitTextToSize(sanitize(input.customer_message), width - 8);
    const boxH = msg.length * 5 + 6;
    doc.setFillColor(240, 250, 245);
    doc.rect(left, y, width, boxH, "F");
    doc.setFillColor(...BRAND_TEAL);
    doc.rect(left, y, 1, boxH, "F");
    doc.setFont("helvetica", "italic");
    doc.setTextColor(15, 110, 86);
    doc.text(msg, left + 5, y + 5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BRAND_DARK);
    y += boxH + 5;
  }

  const rows: [string, string][] = [
    ["Proposal", input.proposal_number],
    ["Balance Due", formatCurrency(input.amount)],
    ["Type", `Refundable (${input.security_deposit_months} month${input.security_deposit_months > 1 ? "s" : ""})`],
    ["Please pay by", formatDate(input.due_date + "T00:00:00")],
  ];
  doc.setFillColor(240, 250, 245);
  doc.rect(left, y, width, rows.length * 8 + 2, "F");
  rows.forEach(([label, value], i) => {
    const rowY = y + 6.5 + i * 8;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(102, 102, 102);
    doc.text(label, left + 4, rowY);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text(sanitize(value), left + 55, rowY);
  });
  y += rows.length * 8 + 10;

  if (input.deposit_link_url) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Pay online", left, y);
    y += 6;

    const qr = await QRCode.toDataURL(input.deposit_link_url, { margin: 1, width: 300 });
    const qrSize = 38;
    doc.addImage(qr, "PNG", left, y, qrSize, qrSize);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...BRAND_DARK);
    doc.text("Scan the QR code, or open this secure Razorpay link:", left + qrSize + 6, y + 10);
    doc.setTextColor(0, 102, 204);
    doc.textWithLink(input.deposit_link_url, left + qrSize + 6, y + 17, { url: input.deposit_link_url });
    y += qrSize + 8;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...BRAND_TEAL);
  doc.text(input.deposit_link_url ? "Or pay by bank transfer" : "Pay by bank transfer", left, y);
  y += 3;

  const bank: [string, string][] = [
    ["Account", COMPANY_BANK_DETAILS.accountName],
    ["A/C No", COMPANY_BANK_DETAILS.accountNumber],
    ["IFSC", COMPANY_BANK_DETAILS.ifscCode],
    ["Bank", `${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}`],
    ["Payment Reference", input.proposal_number],
  ];
  doc.setFontSize(10);
  doc.setFillColor(240, 250, 245);
  doc.rect(left, y, width, bank.length * 7 + 3, "F");
  bank.forEach(([label, value], i) => {
    const rowY = y + 6 + i * 7;
    const isRef = label === "Payment Reference";
    doc.setFont("helvetica", isRef ? "bold" : "normal");
    doc.setTextColor(102, 102, 102);
    doc.text(label, left + 4, rowY);
    doc.setTextColor(...(isRef ? BRAND_TEAL : BRAND_DARK));
    doc.text(value, left + 55, rowY);
  });
  y += bank.length * 7 + 9;

  doc.setFillColor(255, 251, 235);
  doc.setDrawColor(252, 211, 77);
  doc.rect(left, y, width, 10, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(146, 64, 14);
  doc.text(
    `Important: please use ${input.proposal_number} as the payment reference when making the bank transfer.`,
    left + 4,
    y + 6.3
  );
  y += 20;

  doc.setFontSize(10);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Warm regards,", left, y);
  doc.setFont("helvetica", "bold");
  doc.text("The WorkVilla", left, y + 5);

  addFooter(doc);
  return doc;
}

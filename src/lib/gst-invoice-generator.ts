/**
 * GST Invoice PDF Generator — B2B compliant tax invoice.
 *
 * Uses jsPDF + jspdf-autotable (same as pdf-generator.ts).
 * Generates a proper GST invoice with CGST/SGST or IGST split,
 * HSN/SAC codes, service provider/recipient GSTIN, and payment options.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";
import { COMPANY_SEAL_BASE64 } from "@/lib/seal-data";
import { COMPANY_SIGNATURE_BASE64 } from "@/lib/signature-data";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

// TWV Brand Colors
const BRAND_TEAL: [number, number, number] = [1, 94, 101];
const BRAND_GREEN: [number, number, number] = [0, 174, 108];

// Company Details
const SELLER = {
  name: "SREE DESIGN INFRASTRUCTURE PVT LTD",
  brand: "The WorkVilla",
  address: "Prakash Presidium, 110, Mahatma Gandhi Road,\nNungambakkam, Chennai - 600034",
  state: "Tamil Nadu",
  stateCode: "33",
  gstin: "33AAACU4245J1ZF",
  phone: "+91 97910 97900",
  email: "space@theworkvilla.com",
  website: "www.theworkvilla.com",
};

function fmt(amount: number): string {
  // All billing amounts are rounded to the nearest rupee (see src/lib/billing.ts).
  // PDF prints them as whole-rupee integers — no paise — and a "Round Off" line
  // is shown in the totals block so the rounding adjustment is transparent.
  return "Rs. " + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(amount));
}

function formatDateInv(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

// Convert number to words (Indian system)
function amountInWords(input: number): string {
  // Invoices print whole rupees only — round before converting to words.
  const n = Math.round(input);
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  if (n === 0) return "Zero Rupees Only";

  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rem = Math.floor(n % 100);

  let words = "";
  if (crore > 0) words += twoDigit(crore) + " Crore ";
  if (lakh > 0) words += twoDigit(lakh) + " Lakh ";
  if (thousand > 0) words += twoDigit(thousand) + " Thousand ";
  if (hundred > 0) words += ones[hundred] + " Hundred ";
  if (rem > 0) {
    if (words) words += "and ";
    words += twoDigit(rem);
  }

  const paise = Math.round((n - Math.floor(n)) * 100);
  if (paise > 0) {
    return words.trim() + " Rupees and " + twoDigit(paise) + " Paise Only";
  }
  return words.trim() + " Rupees Only";

  function twoDigit(num: number): string {
    if (num < 20) return ones[num];
    return tens[Math.floor(num / 10)] + (num % 10 ? " " + ones[num % 10] : "");
  }
}

/**
 * Place the authorised signatory's signature on the page.
 * (sx, baseY) is the lower-left anchor — the signature sits above baseY.
 * Sized to maxH mm tall; width scales to preserve the source PNG aspect ratio.
 */
function drawSignatureMark(doc: jsPDF, sx: number, baseY: number): void {
  const maxH = 22;
  let sigW = maxH;
  let sigH = maxH;
  try {
    const props = doc.getImageProperties(COMPANY_SIGNATURE_BASE64);
    sigW = maxH * (props.width / props.height);
    sigH = maxH;
  } catch {
    /* keep square fallback */
  }
  try {
    doc.addImage(COMPANY_SIGNATURE_BASE64, "PNG", sx, baseY - sigH, sigW, sigH);
  } catch {
    /* signature failed to load — silently skip */
  }
}

/**
 * Place the official company seal image on the page.
 * The PNG has a fully transparent background so it blends with the PDF.
 */
function drawCompanySeal(doc: jsPDF, cx: number, cy: number, r: number): void {
  const size = r * 2;
  try {
    doc.addImage(COMPANY_SEAL_BASE64, "PNG", cx - r, cy - r, size, size);
  } catch {
    /* seal failed to load — silently skip */
  }
}

/**
 * Draws the authorised signatory block + company seal.
 * Returns the bottom Y after the block.
 */
function drawSignatureBlock(doc: jsPDF, startY: number, pageWidth: number): number {
  const sealR = 19;
  const sigX = 14;
  const sigW = 20;       // signature image width
  const sealCx = sigX + sigW + 6 + sealR;   // seal sits to the right of the signature
  const sealCy = startY + sealR + 6;        // align seal vertical centre with signature mid
  let sy = startY + 5;

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("For SREE DESIGN INFRASTRUCTURE PVT LTD", sigX, sy);
  sy += 3;

  // Reserve room for the signature image (~22mm tall) then drop the line
  const sigBaseline = sy + 22;
  drawSignatureMark(doc, sigX, sigBaseline);
  sy = sigBaseline;

  doc.setDrawColor(120, 120, 120);
  doc.setLineWidth(0.3);
  doc.line(sigX, sy, sigX + 68, sy);
  sy += 4;

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(40, 40, 40);
  doc.text("Authorised Signatory", sigX, sy);

  drawCompanySeal(doc, sealCx, sealCy, sealR);

  return Math.max(sy + 4, sealCy + sealR + 4);
}

export interface GstInvoiceData {
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  /** When true, renders as "PROFORMA INVOICE" and omits GST registration footer note */
  isProforma?: boolean;
  // Buyer
  buyerName: string;
  buyerAddress?: string;
  buyerGstin?: string;
  buyerState?: string;
  buyerStateCode?: string;
  // Billing
  periodStart: string;
  periodEnd: string;
  contractNumber: string;
  /** Customer payment due date (proforma only). YYYY-MM-DD. Printed in the totals block. */
  dueDate?: string;
  // Line items
  lineItems: { description: string; hsnSac: string; qty: number; rate: number; amount: number }[];
  // Totals
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalAmount: number;
  isInterstate: boolean;
  taxPercentage: number;
  // Payment
  razorpayUrl?: string;
  /** Base64 PNG QR code for the Razorpay payment link — proforma only */
  razorpayQrBase64?: string;
  /** Human-readable expiry date of the payment link, e.g. "May 28, 2026" */
  razorpayExpiry?: string;
  upiId?: string;
}

export function generateGstInvoicePDF(data: GstInvoiceData): jsPDF {
  const doc = new jsPDF("p", "mm", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 10;

  const isProforma = data.isProforma === true;

  // ── Header: Teal bar + logo ──
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 4, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 4, pageWidth, 0.8, "F");

  // Logo
  try {
    doc.addImage(TWV_LOGO_BASE64, "PNG", 14, 8, 52, 13);
  } catch { /* skip if logo fails */ }

  // Title: TAX INVOICE or PROFORMA INVOICE
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(isProforma ? "PROFORMA INVOICE" : "TAX INVOICE", pageWidth - 14, 16, { align: "right" });

  // Invoice details (right side)
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  if (isProforma) {
    doc.text(`Proforma Ref: ${data.invoiceNumber}`, pageWidth - 14, 22, { align: "right" });
    doc.text(`Date: ${formatDateInv(data.invoiceDate)}`, pageWidth - 14, 27, { align: "right" });
    doc.text(`Contract: ${data.contractNumber}`, pageWidth - 14, 32, { align: "right" });
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
  } else {
    doc.text(`Invoice No: ${data.invoiceNumber}`, pageWidth - 14, 22, { align: "right" });
    doc.text(`Date: ${formatDateInv(data.invoiceDate)}`, pageWidth - 14, 27, { align: "right" });
    doc.text(`Contract: ${data.contractNumber}`, pageWidth - 14, 32, { align: "right" });
  }

  y = 38;

  // ── Seller / Buyer box ──
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.rect(14, y, pageWidth - 28, 36);
  doc.line(pageWidth / 2, y, pageWidth / 2, y + 36);

  // Service Provider (left)
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("SERVICE PROVIDER", 16, y + 5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(60, 60, 60);
  doc.text(SELLER.name, 16, y + 10);
  doc.text(SELLER.brand, 16, y + 14);
  const sellerAddr = doc.splitTextToSize(SELLER.address, pageWidth / 2 - 20);
  doc.text(sellerAddr, 16, y + 18);
  doc.text(`GSTIN: ${SELLER.gstin}`, 16, y + 26);
  doc.text(`State: ${SELLER.state} (${SELLER.stateCode})`, 16, y + 30);

  // Service Recipient (right)
  const bx = pageWidth / 2 + 4;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("SERVICE RECIPIENT", bx, y + 5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);
  doc.text(data.buyerName, bx, y + 10);
  if (data.buyerAddress) {
    const buyerAddr = doc.splitTextToSize(data.buyerAddress, pageWidth / 2 - 20);
    doc.text(buyerAddr, bx, y + 14);
  }
  if (data.buyerGstin) doc.text(`GSTIN: ${data.buyerGstin}`, bx, y + 22);
  if (data.buyerState) doc.text(`State: ${data.buyerState}${data.buyerStateCode ? ` (${data.buyerStateCode})` : ""}`, bx, y + 26);
  doc.text(`Place of Supply: ${data.isInterstate ? (data.buyerState || "Other") : SELLER.state}`, bx, y + 30);

  y += 40;

  // ── Supply details ──
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text(`Billing Period: ${formatDateInv(data.periodStart)} to ${formatDateInv(data.periodEnd)}`, 14, y);
  doc.text("Reverse Charge: No", pageWidth - 14, y, { align: "right" });
  y += 6;

  // ── Line items table ──
  const taxRate = data.taxPercentage || 18;
  const halfRate = taxRate / 2;

  const tableColumns = data.isInterstate
    ? ["#", "Description", "HSN/SAC", "Qty", "Rate", "Amount", `IGST @${taxRate}%`, "Total"]
    : ["#", "Description", "HSN/SAC", "Qty", "Rate", "Amount", `CGST @${halfRate}%`, `SGST @${halfRate}%`, "Total"];

  const tableRows = data.lineItems.map((item, i) => {
    const itemCgst = Math.round(item.amount * (halfRate / 100));
    const itemSgst = itemCgst;
    const itemIgst = Math.round(item.amount * (taxRate / 100));
    const itemTotal = Math.round(item.amount) + (data.isInterstate ? itemIgst : itemCgst + itemSgst);

    return data.isInterstate
      ? [String(i + 1), item.description, item.hsnSac, String(item.qty), fmt(item.rate), fmt(item.amount), fmt(itemIgst), fmt(itemTotal)]
      : [String(i + 1), item.description, item.hsnSac, String(item.qty), fmt(item.rate), fmt(item.amount), fmt(itemCgst), fmt(itemSgst), fmt(itemTotal)];
  });

  autoTable(doc, {
    startY: y,
    head: [tableColumns],
    body: tableRows,
    theme: "grid",
    headStyles: { fillColor: [1, 94, 101], textColor: [255, 255, 255], fontSize: 7.5, fontStyle: "bold" },
    bodyStyles: { fontSize: 7.5, textColor: [60, 60, 60] },
    columnStyles: {
      0: { cellWidth: 8, halign: "center" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 16, halign: "center" },
      3: { cellWidth: 12, halign: "center" },
    },
    margin: { left: 14, right: 14 },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 6;

  // ── Totals section ──
  const totalsX = pageWidth - 80;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);

  const totals: [string, string][] = [
    ["Subtotal", fmt(data.subtotal)],
  ];
  if (data.isInterstate) {
    totals.push([`IGST @${taxRate}%`, fmt(data.igst)]);
  } else {
    totals.push([`CGST @${halfRate}%`, fmt(data.cgst)]);
    totals.push([`SGST @${halfRate}%`, fmt(data.sgst)]);
  }

  // Round-off line — the gap between (subtotal + tax components) and the
  // stored totalAmount. With rupee-rounded inputs this is usually 0, but we
  // show it explicitly per Indian invoice convention so the math is
  // transparent (and any paise-precision upstream is reconciled here).
  const taxSum = data.isInterstate ? data.igst : data.cgst + data.sgst;
  const roundedTotal = Math.round(data.totalAmount);
  const roundOff = roundedTotal - (Math.round(data.subtotal) + Math.round(taxSum));
  const roundOffStr = (roundOff >= 0 ? "+ " : "- ") + "Rs. " +
    new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.abs(roundOff));
  totals.push(["Round Off", roundOffStr]);

  totals.forEach(([label, value]) => {
    doc.text(label, totalsX, y);
    doc.text(value, pageWidth - 14, y, { align: "right" });
    y += 5;
  });

  // Total with highlight
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(totalsX - 4, y - 1, pageWidth - totalsX + 4 - 10, 8, "F");
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.text("TOTAL", totalsX, y + 5);
  doc.text(fmt(data.totalAmount), pageWidth - 14, y + 5, { align: "right" });
  y += 14;

  // Amount in words
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  doc.text(`Amount in words: ${amountInWords(data.totalAmount)}`, 14, y);
  y += 5;

  // Payment due date (proforma only) — printed in amber so it draws the eye.
  if (isProforma && data.dueDate) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(180, 83, 9); // amber-700
    doc.text(`Payment Due By: ${formatDateInv(data.dueDate)}`, 14, y);
    y += 5;
    doc.setTextColor(80, 80, 80);
  }
  y += 3;

  // ── Payment Options ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Payment Options", 14, y);
  y += 6;

  // QR code column width (only for proforma with QR)
  const qrSize = 36; // mm
  const qrMargin = 6; // gap between text and QR
  const hasQr = isProforma && !!data.razorpayQrBase64;
  const textColWidth = hasQr ? pageWidth - 28 - qrSize - qrMargin : pageWidth - 28;
  const qrX = 14 + textColWidth + qrMargin;
  const qrStartY = y;

  // Bank details (left side)
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(60, 60, 60);
  const bankLines = [
    `Account Name: ${COMPANY_BANK_DETAILS.accountName}`,
    `Account No: ${COMPANY_BANK_DETAILS.accountNumber}`,
    `IFSC: ${COMPANY_BANK_DETAILS.ifscCode}`,
    `Bank: ${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}`,
  ];

  bankLines.forEach((line) => {
    doc.text(line, 14, y);
    y += 4.5;
  });

  if (data.upiId) {
    doc.text(`UPI: ${data.upiId}`, 14, y);
    y += 4.5;
  }

  if (data.razorpayUrl) {
    doc.setTextColor(...BRAND_TEAL);
    doc.setFont("helvetica", "bold");
    doc.text("Pay Online:", 14, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    const urlLines = doc.splitTextToSize(data.razorpayUrl, textColWidth - 24);
    doc.text(urlLines, 14 + 22, y);
    y += 4.5 * urlLines.length;
    doc.setFontSize(8);

    // "PAY NOW" clickable button
    if (isProforma) {
      const btnW = 28;
      const btnH = 7;
      const btnX = 14;
      const btnY = y;
      // Green filled button
      doc.setFillColor(0, 160, 95);
      doc.roundedRect(btnX, btnY, btnW, btnH, 1.5, 1.5, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(255, 255, 255);
      doc.text("PAY NOW →", btnX + btnW / 2, btnY + 4.8, { align: "center" });
      // Make the button area a clickable hyperlink
      doc.link(btnX, btnY, btnW, btnH, { url: data.razorpayUrl });
      y += btnH + 3;
    }
  }

  // QR code block (right column) — proforma only
  if (hasQr && data.razorpayQrBase64) {
    try {
      const qrY = qrStartY - 4;
      doc.addImage(data.razorpayQrBase64, "PNG", qrX, qrY, qrSize, qrSize);
      doc.setFontSize(6.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...BRAND_TEAL);
      doc.text("SCAN TO PAY", qrX + qrSize / 2, qrY + qrSize + 3.5, { align: "center" });
      if (data.razorpayExpiry) {
        doc.setFont("helvetica", "normal");
        doc.setTextColor(120, 60, 0);
        doc.text(`Link valid until: ${data.razorpayExpiry}`, qrX + qrSize / 2, qrY + qrSize + 7, { align: "center" });
      }
      // Ensure y accounts for QR block height
      const qrBottomY = qrY + qrSize + 10;
      if (qrBottomY > y) y = qrBottomY;
    } catch { /* skip QR if image fails */ }
  }

  y += 4;

  // ── Footer ──
  const pageHeight = doc.internal.pageSize.getHeight();
  const footerH = 18;
  const footerY = pageHeight - footerH;

  // Signature block + seal — render if there's enough vertical room
  const sigBlockH = 55; // mm needed for the block (signature 22mm + seal r=19 + text)
  if (y + sigBlockH < footerY - 4) {
    y = drawSignatureBlock(doc, y, pageWidth);
  }

  // Proforma disclaimer — subtle footer note
  if (isProforma) {
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(140, 100, 40);
    doc.text("Not a tax document — GST invoice will be issued upon payment.", pageWidth / 2, footerY - 3, { align: "center" });
  }

  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, footerY, pageWidth, footerH, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, footerY, pageWidth, 0.6, "F");

  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text(`${SELLER.brand}  |  ${SELLER.name}`, pageWidth / 2, footerY + 5, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(200, 230, 220);
  doc.text(`${SELLER.address.replace(/\n/g, " ")}  |  ${SELLER.phone}  |  ${SELLER.website}`, pageWidth / 2, footerY + 10, { align: "center" });
  doc.text(`GSTIN: ${SELLER.gstin}`, pageWidth / 2, footerY + 14, { align: "center" });

  return doc;
}

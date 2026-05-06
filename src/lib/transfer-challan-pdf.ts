/**
 * Transfer Challan PDF Generator
 *
 * Generates branded Delivery Challan PDFs for stock transfers using jsPDF + autoTable.
 * Uses the same TWV brand identity as po-pdf-generator.ts.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";
import type { StockTransfer } from "@/types";

// ── TWV Brand Colors ──────────────────────────────────────────────────────────
const BRAND_TEAL: [number, number, number] = [1, 94, 101];   // #015E65
const BRAND_DARK: [number, number, number] = [26, 27, 30];   // #1A1B1E

// ── Company Details ───────────────────────────────────────────────────────────
const COMPANY_NAME = "SREE DESIGN INFRASTRUCTURE PVT LTD";
const COMPANY_ADDRESS = [
  "Prakash Presidium, 110, Mahatma Gandhi Road,",
  "Nungambakkam, Chennai - 600034",
];
const COMPANY_PHONE = "+91 97910 97900";
const COMPANY_EMAIL = "contact@theworkvilla.com";
const COMPANY_GST = "GST: 33AAACU4245J1ZF";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDatePDF(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Adds the TWV logo + company header. Returns the Y position after the header. */
function addLogoToDoc(doc: jsPDF): number {
  const pageWidth = doc.internal.pageSize.getWidth();

  // Teal accent bar at the very top
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 3, "F");

  // Logo image (left side)
  const logoW = 52;
  const logoH = 13;
  doc.addImage(TWV_LOGO_BASE64, "PNG", 14, 8, logoW, logoH);

  // Company details (right-aligned)
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(COMPANY_NAME, pageWidth - 14, 10, { align: "right" });
  doc.text(COMPANY_ADDRESS[0], pageWidth - 14, 14, { align: "right" });
  doc.text(COMPANY_ADDRESS[1], pageWidth - 14, 18, { align: "right" });
  doc.setTextColor(...BRAND_TEAL);
  doc.text(`${COMPANY_PHONE}  |  ${COMPANY_EMAIL}`, pageWidth - 14, 22, { align: "right" });
  doc.setTextColor(100, 100, 100);
  doc.text(COMPANY_GST, pageWidth - 14, 26, { align: "right" });

  return 32;
}

// ── Main Export ───────────────────────────────────────────────────────────────

export function generateTransferChallanPDF(transfer: StockTransfer): jsPDF {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Header ──
  let y = addLogoToDoc(doc);

  // ── Divider ──
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageWidth - 14, y);
  y += 8;

  // ── Document Title & Transfer Number ──
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("DELIVERY CHALLAN", 14, y);

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(transfer.transfer_number, pageWidth - 14, y, { align: "right" });

  y += 6;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Date: ${formatDatePDF(transfer.created_at)}`, pageWidth - 14, y, { align: "right" });

  y += 10;

  // ── Transfer Info Panel (light blue background) ──
  const panelH = 34;

  doc.setFillColor(235, 245, 255);
  doc.rect(14, y - 4, pageWidth - 28, panelH, "F");
  doc.setDrawColor(180, 210, 240);
  doc.setLineWidth(0.3);
  doc.rect(14, y - 4, pageWidth - 28, panelH);

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("TRANSFER DETAILS", 18, y);

  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(50, 50, 50);

  const col1x = 18;
  const col2x = pageWidth / 2 + 10;

  // Row 1: From Location | To Location
  doc.setFont("helvetica", "bold");
  doc.text("From Location:", col1x, y);
  doc.setFont("helvetica", "normal");
  const fromName = transfer.from_location?.name ?? "—";
  const fromCode = transfer.from_location?.code ? ` (${transfer.from_location.code})` : "";
  doc.text(`${fromName}${fromCode}`, col1x + 30, y);

  doc.setFont("helvetica", "bold");
  doc.text("To Location:", col2x, y);
  doc.setFont("helvetica", "normal");
  const toName = transfer.to_location?.name ?? "—";
  const toCode = transfer.to_location?.code ? ` (${transfer.to_location.code})` : "";
  doc.text(`${toName}${toCode}`, col2x + 28, y);

  // Row 2: Initiated By | Approved By
  y += 5;
  doc.setFont("helvetica", "bold");
  doc.text("Initiated By:", col1x, y);
  doc.setFont("helvetica", "normal");
  doc.text(transfer.initiator?.full_name ?? "—", col1x + 30, y);

  doc.setFont("helvetica", "bold");
  doc.text("Approved By:", col2x, y);
  doc.setFont("helvetica", "normal");
  doc.text(transfer.approver?.full_name ?? "—", col2x + 28, y);

  // Row 3: Transfer Number | Date (repeated for panel completeness)
  y += 5;
  doc.setFont("helvetica", "bold");
  doc.text("Transfer No:", col1x, y);
  doc.setFont("helvetica", "normal");
  doc.text(transfer.transfer_number, col1x + 30, y);

  doc.setFont("helvetica", "bold");
  doc.text("Approved On:", col2x, y);
  doc.setFont("helvetica", "normal");
  doc.text(transfer.approved_at ? formatDatePDF(transfer.approved_at) : "—", col2x + 28, y);

  y += 14;

  // ── Notes (if any) ──
  if (transfer.notes) {
    doc.setFillColor(245, 247, 250);
    doc.rect(14, y - 3, pageWidth - 28, 7, "F");
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_DARK);
    doc.text("NOTES", 17, y + 2);

    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    const noteLines = doc.splitTextToSize(transfer.notes, pageWidth - 28);
    doc.text(noteLines, 14, y + 10);
    const lineCount = Array.isArray(noteLines) ? noteLines.length : 1;
    y = y + 10 + lineCount * 4.5 + 4;
  }

  // ── Items Table ──
  const items = transfer.stock_transfer_items ?? [];
  const tableRows = items.map((item, i) => [
    String(i + 1),
    item.item_name,
    item.unit,
    String(item.quantity_sent),
  ]);

  const tableHead = [["S.No", "Item Name", "Unit", "Quantity"]];

  const columnStyles: Record<number, { cellWidth?: number | "auto"; halign?: "left" | "center" | "right" }> = {
    0: { cellWidth: 16, halign: "center" },
    1: { cellWidth: "auto" },
    2: { cellWidth: 30, halign: "center" },
    3: { cellWidth: 30, halign: "right" },
  };

  autoTable(doc, {
    startY: y,
    head: tableHead,
    body: tableRows,
    theme: "striped",
    headStyles: {
      fillColor: BRAND_TEAL,
      textColor: [255, 255, 255],
      fontSize: 9,
      fontStyle: "bold",
    },
    bodyStyles: {
      fontSize: 9,
      textColor: BRAND_DARK,
    },
    columnStyles,
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 14, right: 14 },
  });

  // ── Signature Section ──
  let finalY = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;

  const sigBoxWidth = (pageWidth - 28 - 20) / 2; // two boxes with a gap
  const sigBoxHeight = 30;
  const sigLeftX = 14;
  const sigRightX = 14 + sigBoxWidth + 20;

  // Check if signature section fits on current page; if not, add a new page
  if (finalY + sigBoxHeight + 20 > doc.internal.pageSize.getHeight() - 20) {
    doc.addPage();
    finalY = 20;
  }

  // Dispatcher Signature box
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.3);
  doc.rect(sigLeftX, finalY, sigBoxWidth, sigBoxHeight);

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("Dispatcher Signature", sigLeftX + sigBoxWidth / 2, finalY + sigBoxHeight + 5, { align: "center" });

  // Receiver Signature box
  doc.rect(sigRightX, finalY, sigBoxWidth, sigBoxHeight);
  doc.text("Receiver Signature", sigRightX + sigBoxWidth / 2, finalY + sigBoxHeight + 5, { align: "center" });

  // ── Footer ──
  const footerY = finalY + sigBoxHeight + 14;
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.3);
  doc.line(14, footerY, pageWidth - 14, footerY);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(120, 120, 120);
  doc.text(
    `This is a computer-generated Delivery Challan for internal stock transfer ${transfer.transfer_number}. Please retain for your records.`,
    14,
    footerY + 5,
  );

  return doc;
}

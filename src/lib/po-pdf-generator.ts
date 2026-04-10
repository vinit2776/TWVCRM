/**
 * Purchase Order PDF Generator
 *
 * Generates branded PO PDFs using jsPDF + autoTable.
 * Uses the same TWV brand identity as pdf-generator.ts but is a standalone
 * module to keep concerns separated.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import QRCode from "qrcode";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";
import type { PurchaseOrder } from "@/types";

// ── TWV Brand Colors ──────────────────────────────────────────────────────────
const BRAND_TEAL: [number, number, number] = [1, 94, 101];   // #015E65
const BRAND_GREEN: [number, number, number] = [0, 174, 108]; // #00AE6C
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

function formatCurrencyPDF(amount: number): string {
  // Use "Rs." — jsPDF's Helvetica cannot render the ₹ symbol
  return (
    "Rs. " +
    new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  );
}

function formatDatePDF(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-IN", {
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

// ── Extended PO type for PDF ──────────────────────────────────────────────────
type PoForPDF = PurchaseOrder & {
  purchase_requests?: (Pick<import("@/types").PurchaseRequest, "id" | "pr_number" | "department" | "approval_code" | "approved_at"> & {
    approver?: { id: string; full_name?: string; email?: string } | null;
  }) | null;
  procurement_vendors?: { id: string; name: string; contact_name?: string; contact_phone?: string; contact_email?: string } | null;
  locations?: { id: string; name: string } | null;
  orderer?: { id: string; full_name?: string; email?: string } | null;
};

// ── Main Export ───────────────────────────────────────────────────────────────

export async function generatePurchaseOrderPDF(po: PoForPDF): Promise<jsPDF> {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Header ──
  let y = addLogoToDoc(doc);

  // ── Divider ──
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageWidth - 14, y);
  y += 8;

  // ── Document Title & PO Number ──
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("PURCHASE ORDER", 14, y);

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(po.po_number, pageWidth - 14, y, { align: "right" });

  y += 6;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Date: ${formatDatePDF(po.created_at)}`, pageWidth - 14, y, { align: "right" });

  y += 10;

  // ── Approval Reference Panel (light blue background) ──
  if (po.purchase_requests) {
    const pr = po.purchase_requests;
    const panelH = 24;

    doc.setFillColor(235, 245, 255);
    doc.rect(14, y - 4, pageWidth - 28, panelH, "F");
    doc.setDrawColor(180, 210, 240);
    doc.setLineWidth(0.3);
    doc.rect(14, y - 4, pageWidth - 28, panelH);

    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("APPROVAL REFERENCE", 18, y);

    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(50, 50, 50);

    const col1x = 18;
    const col2x = pageWidth / 2 + 10;

    doc.setFont("helvetica", "bold");
    doc.text("PR Number:", col1x, y);
    doc.setFont("helvetica", "normal");
    doc.text(pr.pr_number ?? "—", col1x + 28, y);

    doc.setFont("helvetica", "bold");
    doc.text("Approval Code:", col2x, y);
    doc.setFont("helvetica", "normal");
    doc.text(pr.approval_code ?? "N/A", col2x + 32, y);

    y += 5;
    doc.setFont("helvetica", "bold");
    doc.text("Approved By:", col1x, y);
    doc.setFont("helvetica", "normal");
    doc.text(pr.approver?.full_name ?? pr.approver?.email ?? "—", col1x + 28, y);

    doc.setFont("helvetica", "bold");
    doc.text("Approved On:", col2x, y);
    doc.setFont("helvetica", "normal");
    doc.text(pr.approved_at ? formatDatePDF(pr.approved_at) : "—", col2x + 32, y);

    y += 10;
  }

  // ── Two-column detail grid: Vendor | Order Details ──
  const colLeft = 14;
  const colRight = pageWidth / 2 + 5;
  const sectionHeaderH = 6;

  // Vendor section header
  doc.setFillColor(240, 250, 245);
  doc.rect(colLeft, y - 4, pageWidth / 2 - 19, sectionHeaderH, "F");
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("VENDOR", colLeft + 2, y);

  // Order Details section header
  doc.setFillColor(240, 250, 245);
  doc.rect(colRight, y - 4, pageWidth / 2 - 19, sectionHeaderH, "F");
  doc.text("ORDER DETAILS", colRight + 2, y);

  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...BRAND_DARK);
  doc.setFontSize(9);

  const vendor = po.procurement_vendors;
  const location = po.locations;
  const orderer = po.orderer;

  // Vendor column
  if (vendor?.name) {
    doc.setFont("helvetica", "bold");
    doc.text(vendor.name, colLeft + 2, y);
    doc.setFont("helvetica", "normal");
  }
  if (vendor?.contact_name) {
    y += 5;
    doc.setTextColor(80, 80, 80);
    doc.text(vendor.contact_name, colLeft + 2, y);
  }
  if (vendor?.contact_phone) {
    y += 4;
    doc.text(vendor.contact_phone, colLeft + 2, y);
  }

  // Order Details column (reset Y for right column)
  const rightStartY = y - (vendor?.contact_name ? 5 : 0) - (vendor?.contact_phone ? 4 : 0);

  let ry = rightStartY;
  doc.setTextColor(...BRAND_DARK);

  if (location?.name) {
    doc.setFont("helvetica", "bold");
    doc.text("Location:", colRight + 2, ry);
    doc.setFont("helvetica", "normal");
    doc.text(location.name, colRight + 22, ry);
    ry += 5;
  }
  if (po.expected_delivery_date) {
    doc.setFont("helvetica", "bold");
    doc.text("Expected:", colRight + 2, ry);
    doc.setFont("helvetica", "normal");
    doc.text(formatDatePDF(po.expected_delivery_date), colRight + 22, ry);
    ry += 5;
  }
  if (po.payment_terms) {
    doc.setFont("helvetica", "bold");
    doc.text("Payment:", colRight + 2, ry);
    doc.setFont("helvetica", "normal");
    doc.text(po.payment_terms, colRight + 22, ry);
    ry += 5;
  }
  if (orderer) {
    doc.setFont("helvetica", "bold");
    doc.text("Ordered By:", colRight + 2, ry);
    doc.setFont("helvetica", "normal");
    doc.text(orderer.full_name ?? orderer.email ?? "—", colRight + 22, ry);
  }

  y = Math.max(y, ry) + 8;

  // ── Line Items Table ──
  const items = po.purchase_order_items ?? [];
  const hasGst = items.some((item) => Number(item.gst_rate) > 0);
  const tableRows = items.map((item, i) => {
    const row = [
      String(i + 1),
      item.item_name,
      item.unit,
      String(item.quantity_ordered),
      item.unit_price != null ? formatCurrencyPDF(item.unit_price) : "—",
    ];
    if (hasGst) {
      row.push(Number(item.gst_rate) > 0 ? `${item.gst_rate}%` : "—");
    }
    const lineTotal = Number(item.total_amount ?? 0) + Number(item.gst_amount ?? 0);
    row.push(lineTotal > 0 ? formatCurrencyPDF(lineTotal) : "—");
    return row;
  });

  const tableHead = hasGst
    ? [["#", "Item", "Unit", "Qty", "Unit Price", "GST%", "Total"]]
    : [["#", "Item", "Unit", "Qty", "Unit Price", "Total"]];

  const columnStyles: Record<number, { cellWidth?: number | "auto"; halign?: "left" | "center" | "right" }> = {
    0: { cellWidth: 10, halign: "center" },
    1: { cellWidth: "auto" },
    2: { cellWidth: 20 },
    3: { cellWidth: 18, halign: "right" },
    4: { cellWidth: 30, halign: "right" },
  };
  if (hasGst) {
    columnStyles[5] = { cellWidth: 18, halign: "right" };
    columnStyles[6] = { cellWidth: 30, halign: "right" };
  } else {
    columnStyles[5] = { cellWidth: 30, halign: "right" };
  }

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

  // ── Guard: ensure enough room on current page for totals + seal + footer ──
  const pageHeight = doc.internal.pageSize.getHeight();
  const FOOTER_MIN_SPACE = 90; // mm needed for totals + terms + QR seal + footer

  let finalY = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

  if (finalY > pageHeight - FOOTER_MIN_SPACE) {
    doc.addPage();
    // Teal accent bar at top of continuation page
    doc.setFillColor(...BRAND_TEAL);
    doc.rect(0, 0, pageWidth, 3, "F");
    // Continuation label
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(160, 160, 160);
    doc.text(`${po.po_number} (continued)`, pageWidth - 14, 10, { align: "right" });
    finalY = 18;
  }

  // ── Totals ──
  const subtotal = Number(po.total_ordered_amount);
  const gstTotal = Number(po.total_gst_amount ?? 0);
  const grandTotal = Number(po.total_amount_with_gst ?? subtotal);

  if (subtotal > 0) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BRAND_DARK);

    if (gstTotal > 0) {
      doc.text("Subtotal:", pageWidth - 75, finalY);
      doc.text(formatCurrencyPDF(subtotal), pageWidth - 14, finalY, { align: "right" });
      finalY += 5;
      doc.text("GST:", pageWidth - 75, finalY);
      doc.text(formatCurrencyPDF(gstTotal), pageWidth - 14, finalY, { align: "right" });
      finalY += 6;
    }

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("GRAND TOTAL:", pageWidth - 75, finalY);
    doc.setTextColor(...BRAND_GREEN);
    doc.text(formatCurrencyPDF(grandTotal), pageWidth - 14, finalY, { align: "right" });
  }

  // ── Terms & Conditions Section ──
  const approvalCode = po.purchase_requests?.approval_code;

  let footerStartY = finalY + (subtotal > 0 ? 18 : 8);
  if (po.terms_and_conditions) {
    // Guard: TC block needs space — push to new page if needed
    if (footerStartY > pageHeight - 60) {
      doc.addPage();
      doc.setFillColor(...BRAND_TEAL);
      doc.rect(0, 0, pageWidth, 3, "F");
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(160, 160, 160);
      doc.text(`${po.po_number} (continued)`, pageWidth - 14, 10, { align: "right" });
      footerStartY = 18;
    }

    const tcStartY = footerStartY;
    doc.setFillColor(245, 247, 250);
    doc.rect(14, tcStartY - 3, pageWidth - 28, 7, "F");
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_DARK);
    doc.text("TERMS & CONDITIONS", 17, tcStartY + 2);

    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    const tcLines = doc.splitTextToSize(po.terms_and_conditions, pageWidth - 28);
    doc.text(tcLines, 14, tcStartY + 10);
    const lineCount = Array.isArray(tcLines) ? tcLines.length : 1;
    footerStartY = tcStartY + 10 + lineCount * 4.5 + 6;
  }

  // ── Verification Seal + QR Code ──
  // Guard: seal needs ~40mm — push to new page if it would overflow
  if (approvalCode && footerStartY > pageHeight - 50) {
    doc.addPage();
    doc.setFillColor(...BRAND_TEAL);
    doc.rect(0, 0, pageWidth, 3, "F");
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(160, 160, 160);
    doc.text(`${po.po_number} (continued)`, pageWidth - 14, 10, { align: "right" });
    footerStartY = 18;
  }

  if (approvalCode) {
    const appUrl = (typeof window !== "undefined" ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").replace(/\/$/, "");
    const verifyUrl = `${appUrl}/verify/${encodeURIComponent(approvalCode)}`;

    const sealY = footerStartY;
    const qrSize = 28;
    const sealW = 85;
    const sealH = 30;
    const sealX = pageWidth - 14 - sealW;

    // QR Code (left of seal)
    try {
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 200, margin: 1, color: { dark: "#015E65", light: "#FFFFFF" } });
      doc.addImage(qrDataUrl, "PNG", sealX - qrSize - 4, sealY, qrSize, qrSize);
      doc.setFontSize(5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(120, 120, 120);
      doc.text("Scan to verify", sealX - qrSize - 4 + qrSize / 2, sealY + qrSize + 3, { align: "center" });
    } catch { /* QR generation failed — continue without it */ }

    // Seal box
    doc.setDrawColor(...BRAND_TEAL);
    doc.setLineWidth(1);
    doc.rect(sealX, sealY, sealW, sealH);
    doc.setLineWidth(0.3);
    doc.rect(sealX + 1.5, sealY + 1.5, sealW - 3, sealH - 3);

    // "VERIFIED" label
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("VERIFIED APPROVAL", sealX + sealW / 2, sealY + 7, { align: "center" });

    // Approval code (large, prominent)
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_DARK);
    doc.text(approvalCode, sealX + sealW / 2, sealY + 15, { align: "center" });

    // Signature hint
    doc.setFontSize(5.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(120, 120, 120);
    doc.text("Cryptographically signed & verifiable", sealX + sealW / 2, sealY + 21, { align: "center" });

    // Verify URL
    doc.setFontSize(5);
    doc.setTextColor(...BRAND_TEAL);
    doc.text(verifyUrl, sealX + sealW / 2, sealY + 26, { align: "center" });

    footerStartY = sealY + sealH + 6;
  }

  // ── Footer ──
  const footerY = footerStartY;
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.3);
  doc.line(14, footerY, pageWidth - 14, footerY);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(120, 120, 120);
  doc.text(
    `This is a computer-generated Purchase Order.${approvalCode ? ` Approval reference: ${approvalCode}.` : ""} Please retain for your records.`,
    14,
    footerY + 5
  );

  return doc;
}

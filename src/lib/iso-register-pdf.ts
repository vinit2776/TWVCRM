/**
 * ISO 9001 register PDF generator — reproduces the client's audit-format
 * paper registers (company header, Doc No./Rev No. box, tabular data,
 * signature block) from live CRM data.
 *
 * Uses jsPDF + jspdf-autotable, same stack as pdf-generator.ts /
 * gst-invoice-generator.ts. Unlike those, this repeats the branded header
 * on every page via autoTable's didDrawPage hook — ISO registers routinely
 * run 80+ rows and need the header legible on every page for an auditor.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const BRAND_TEAL: [number, number, number] = [1, 94, 101];
const TEXT_DARK: [number, number, number] = [26, 27, 30];

// Legal entity name exactly as printed on the client's existing ISO forms
// (distinct from the abbreviated "SREE DESIGN INFRASTRUCTURE PVT LTD" used
// on invoices — audit documents must match the paper trail verbatim).
export const ISO_COMPANY_NAME = "SREE DESIGN INFRASTRUCTURE PRIVATE LIMITED";

export interface IsoRegisterColumn {
  header: string;
  dataKey: string;
  width?: number;
}

export interface IsoRegisterConfig {
  /** e.g. "SDI/OPFM/F/16" */
  docNo: string;
  /** e.g. "00" */
  revNo: string;
  /** e.g. "28-11-2025" */
  revDate: string;
  /** e.g. "FACILITIES MANAGEMENT TICKETING SYSTEM" */
  title: string;
  /** e.g. "Period: 01-Jan-2026 to 31-Jan-2026" */
  filterLine?: string;
  columns: IsoRegisterColumn[];
  rows: Record<string, string>[];
  /** Defaults to ["Prepared By", "Verified By"] */
  signatureLabels?: [string, string];
}

const HEADER_HEIGHT = 32;

function drawHeader(doc: jsPDF, config: IsoRegisterConfig): void {
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 3, "F");

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...TEXT_DARK);
  doc.text(ISO_COMPANY_NAME, 14, 12);

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(config.title, 14, 19);

  // Doc No. / Rev No./Date box — top right, matches the paper forms' layout
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Doc.No.: ${config.docNo}`, pageWidth - 14, 10, { align: "right" });
  doc.text(`Rev.No./Date: ${config.revNo}/${config.revDate}`, pageWidth - 14, 15, { align: "right" });

  if (config.filterLine) {
    doc.setFontSize(9);
    doc.setTextColor(...TEXT_DARK);
    doc.text(config.filterLine, 14, 26);
  }

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.line(14, HEADER_HEIGHT - 3, pageWidth - 14, HEADER_HEIGHT - 3);
}

function drawSignatureBlock(doc: jsPDF, startY: number, pageWidth: number, labels: [string, string]): void {
  const colWidth = (pageWidth - 28) / 2;
  const lineY = startY + 14;

  for (let i = 0; i < labels.length; i++) {
    const x = 14 + i * colWidth;
    doc.setDrawColor(120, 120, 120);
    doc.setLineWidth(0.3);
    doc.line(x, lineY, x + 55, lineY);
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(40, 40, 40);
    doc.text(labels[i], x, lineY + 4);
  }
}

export function generateIsoRegisterPDF(config: IsoRegisterConfig): jsPDF {
  const doc = new jsPDF("l", "mm", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const signatureLabels = config.signatureLabels ?? ["Prepared By", "Verified By"];

  autoTable(doc, {
    startY: HEADER_HEIGHT,
    columns: config.columns.map((c) => ({ header: c.header, dataKey: c.dataKey })),
    body: config.rows,
    theme: "grid",
    headStyles: {
      fillColor: BRAND_TEAL,
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 8,
    },
    bodyStyles: { fontSize: 7.5, textColor: TEXT_DARK, cellPadding: 1.5 },
    alternateRowStyles: { fillColor: [245, 248, 248] },
    columnStyles: Object.fromEntries(
      config.columns.map((c, i) => [i, c.width ? { cellWidth: c.width } : {}])
    ),
    margin: { left: 14, right: 14, top: HEADER_HEIGHT },
    didDrawPage: () => drawHeader(doc, config),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalY = (doc as any).lastAutoTable.finalY as number;
  if (finalY + 22 > pageHeight - 10) {
    doc.addPage();
    drawHeader(doc, config);
    drawSignatureBlock(doc, HEADER_HEIGHT + 6, pageWidth, signatureLabels);
  } else {
    drawSignatureBlock(doc, finalY + 6, pageWidth, signatureLabels);
  }

  if (config.rows.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    doc.text("No records found for the selected period.", 14, HEADER_HEIGHT + 10);
  }

  return doc;
}

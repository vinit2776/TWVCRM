import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { Proposal, ProformaInvoice, Lead, LineItem } from "@/types";

function formatCurrencyPDF(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDatePDF(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface PDFOptions {
  title: string;
  documentNumber: string;
  items: LineItem[];
  subtotal: number;
  taxPercentage: number;
  taxAmount: number;
  discountPercentage: number;
  discountAmount: number;
  totalAmount: number;
  lead?: Partial<Lead>;
  createdAt: string;
  validUntil?: string;
  dueDate?: string;
  description?: string;
  termsAndConditions?: string;
  notes?: string;
}

function generatePDF(options: PDFOptions): jsPDF {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 20;

  // ── Header ──
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 64, 175); // Blue
  doc.text("TWV Coworking", 14, y);

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text("Premium Workspace Solutions", 14, y + 7);

  // Document number & date — right aligned
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(options.documentNumber, pageWidth - 14, y, { align: "right" });
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Date: ${formatDatePDF(options.createdAt)}`, pageWidth - 14, y + 7, {
    align: "right",
  });

  if (options.validUntil) {
    doc.text(
      `Valid Until: ${formatDatePDF(options.validUntil)}`,
      pageWidth - 14,
      y + 13,
      { align: "right" }
    );
  }
  if (options.dueDate) {
    doc.text(
      `Due Date: ${formatDatePDF(options.dueDate)}`,
      pageWidth - 14,
      y + 13,
      { align: "right" }
    );
  }

  // ── Divider ──
  y += 22;
  doc.setDrawColor(200, 200, 200);
  doc.line(14, y, pageWidth - 14, y);
  y += 10;

  // ── Title ──
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(options.title, 14, y);
  y += 8;

  // ── Description ──
  if (options.description) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    const lines = doc.splitTextToSize(options.description, pageWidth - 28);
    doc.text(lines, 14, y);
    y += lines.length * 5 + 4;
  }

  // ── Prepared For (Lead Info) ──
  if (options.lead) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(100, 100, 100);
    doc.text("PREPARED FOR", 14, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 30, 30);
    const leadName = `${options.lead.first_name || ""} ${options.lead.last_name || ""}`.trim();
    if (leadName) {
      doc.text(leadName, 14, y);
      y += 5;
    }
    if (options.lead.company) {
      doc.text(options.lead.company, 14, y);
      y += 5;
    }
    if (options.lead.email) {
      doc.text(options.lead.email, 14, y);
      y += 5;
    }
    if (options.lead.phone || options.lead.mobile) {
      doc.text(options.lead.phone || options.lead.mobile || "", 14, y);
      y += 5;
    }
    y += 4;
  }

  // ── Line Items Table ──
  const tableRows = options.items.map((item, i) => [
    String(i + 1),
    item.description,
    String(item.quantity),
    formatCurrencyPDF(item.unit_price),
    formatCurrencyPDF(item.total),
  ]);

  autoTable(doc, {
    startY: y,
    head: [["#", "Description", "Qty", "Unit Price", "Total"]],
    body: tableRows,
    theme: "striped",
    headStyles: {
      fillColor: [30, 64, 175],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 10,
    },
    bodyStyles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 12, halign: "center" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 18, halign: "center" },
      3: { cellWidth: 35, halign: "right" },
      4: { cellWidth: 35, halign: "right" },
    },
    margin: { left: 14, right: 14 },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // ── Totals Section ──
  const totalsX = pageWidth - 80;
  const totalsValueX = pageWidth - 14;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);

  doc.text("Subtotal:", totalsX, y);
  doc.text(formatCurrencyPDF(options.subtotal), totalsValueX, y, {
    align: "right",
  });
  y += 6;

  if (options.taxPercentage > 0) {
    doc.text(`Tax (${options.taxPercentage}%):`, totalsX, y);
    doc.text(formatCurrencyPDF(options.taxAmount), totalsValueX, y, {
      align: "right",
    });
    y += 6;
  }

  if (options.discountPercentage > 0) {
    doc.text(`Discount (${options.discountPercentage}%):`, totalsX, y);
    doc.text(`-${formatCurrencyPDF(options.discountAmount)}`, totalsValueX, y, {
      align: "right",
    });
    y += 6;
  }

  // Total line
  doc.setDrawColor(30, 64, 175);
  doc.line(totalsX, y, totalsValueX, y);
  y += 6;

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 64, 175);
  doc.text("Total:", totalsX, y);
  doc.text(formatCurrencyPDF(options.totalAmount), totalsValueX, y, {
    align: "right",
  });
  y += 12;

  // ── Terms & Conditions ──
  if (options.termsAndConditions) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text("Terms & Conditions", 14, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const tcLines = doc.splitTextToSize(
      options.termsAndConditions,
      pageWidth - 28
    );
    doc.text(tcLines, 14, y);
    y += tcLines.length * 4.5 + 6;
  }

  // ── Notes ──
  if (options.notes) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text("Notes", 14, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const notesLines = doc.splitTextToSize(options.notes, pageWidth - 28);
    doc.text(notesLines, 14, y);
  }

  // ── Footer ──
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(150, 150, 150);
  doc.text(
    "Generated by TWV CRM | TWV Coworking",
    pageWidth / 2,
    pageHeight - 10,
    { align: "center" }
  );

  return doc;
}

export function generateProposalPDF(
  proposal: Proposal,
  lead?: Partial<Lead>
): jsPDF {
  return generatePDF({
    title: proposal.title,
    documentNumber: proposal.proposal_number,
    items: proposal.items,
    subtotal: proposal.subtotal,
    taxPercentage: proposal.tax_percentage,
    taxAmount: proposal.tax_amount,
    discountPercentage: proposal.discount_percentage,
    discountAmount: proposal.discount_amount,
    totalAmount: proposal.total_amount,
    lead,
    createdAt: proposal.created_at,
    validUntil: proposal.valid_until,
    description: proposal.description,
    termsAndConditions: proposal.terms_and_conditions,
    notes: proposal.notes,
  });
}

export function generateInvoicePDF(
  invoice: ProformaInvoice,
  lead?: Partial<Lead>
): jsPDF {
  return generatePDF({
    title: invoice.title,
    documentNumber: invoice.invoice_number,
    items: invoice.items,
    subtotal: invoice.subtotal,
    taxPercentage: invoice.tax_percentage,
    taxAmount: invoice.tax_amount,
    discountPercentage: invoice.discount_percentage,
    discountAmount: invoice.discount_amount,
    totalAmount: invoice.total_amount,
    lead,
    createdAt: invoice.created_at,
    dueDate: invoice.due_date,
    notes: invoice.notes,
  });
}

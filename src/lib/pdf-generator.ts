import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { Proposal, ProformaInvoice, Lead, LineItem, Contract, BillingStatement } from "@/types";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";
import { BILLING_CYCLE_LABELS, COMPANY_BANK_DETAILS } from "@/lib/constants";

// TWV Brand Colors
const BRAND_TEAL: [number, number, number] = [1, 94, 101]; // #015E65
const BRAND_GREEN: [number, number, number] = [0, 174, 108]; // #00AE6C
const BRAND_DARK: [number, number, number] = [26, 27, 30]; // #1A1B1E

// Company Details
const COMPANY_NAME = "SREE DESIGN INFRASTRUCTURE PVT LTD";
const BRAND_NAME = "The WorkVilla";
const COMPANY_ADDRESS = [
  "Prakash Presidium, 110, Mahatma Gandhi Road,",
  "Nungambakkam, Chennai - 600034",
];
const COMPANY_PHONE = "+91 97910 97900";
const COMPANY_EMAIL = "contact@theworkvilla.com";
const COMPANY_WEBSITE = "www.theworkvilla.com";
const COMPANY_GST = "GST: 33AAACU4245J1ZF";

function formatCurrencyPDF(amount: number): string {
  // Use "Rs." instead of Unicode ₹ symbol — jsPDF's Helvetica cannot render ₹
  return (
    "Rs. " +
    new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount)
  );
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

function addLogoToDoc(doc: jsPDF): number {
  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Teal accent bar at the very top ──
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 3, "F");

  // ── Logo image (left side) ──
  // Original logo aspect ratio is ~4:1 (1024x260)
  const logoW = 52;
  const logoH = 13;
  doc.addImage(TWV_LOGO_BASE64, "PNG", 14, 8, logoW, logoH);

  // ── Company details (right-aligned, beside logo) ──
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(COMPANY_NAME, pageWidth - 14, 10, { align: "right" });
  doc.text(COMPANY_ADDRESS[0], pageWidth - 14, 14, { align: "right" });
  doc.text(COMPANY_ADDRESS[1], pageWidth - 14, 18, { align: "right" });
  doc.setTextColor(...BRAND_TEAL);
  doc.text(
    `${COMPANY_PHONE}  |  ${COMPANY_EMAIL}`,
    pageWidth - 14,
    22,
    { align: "right" }
  );
  doc.setTextColor(100, 100, 100);
  doc.text(COMPANY_GST, pageWidth - 14, 26, { align: "right" });

  return 32;
}

function generatePDF(options: PDFOptions): jsPDF {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Header with Logo ──
  let y = addLogoToDoc(doc);

  // ── Divider ──
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageWidth - 14, y);
  y += 10;

  // ── Document Title & Number ──
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text(options.title, 14, y);

  // Document number & date — right aligned
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(options.documentNumber, pageWidth - 14, y, { align: "right" });
  y += 7;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Date: ${formatDatePDF(options.createdAt)}`, pageWidth - 14, y, {
    align: "right",
  });

  if (options.validUntil) {
    y += 5;
    doc.text(
      `Valid Until: ${formatDatePDF(options.validUntil)}`,
      pageWidth - 14,
      y,
      { align: "right" }
    );
  }
  if (options.dueDate) {
    y += 5;
    doc.text(
      `Due Date: ${formatDatePDF(options.dueDate)}`,
      pageWidth - 14,
      y,
      { align: "right" }
    );
  }

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
    // Section header with teal accent
    doc.setFillColor(240, 250, 245); // light green-gray bg
    doc.rect(14, y - 4, pageWidth - 28, 6, "F");
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("PREPARED FOR", 16, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BRAND_DARK);
    const leadName = `${options.lead.first_name || ""} ${options.lead.last_name || ""}`.trim();
    if (leadName) {
      doc.setFont("helvetica", "bold");
      doc.text(leadName, 16, y);
      doc.setFont("helvetica", "normal");
      y += 5;
    }
    if (options.lead.company) {
      doc.text(options.lead.company, 16, y);
      y += 5;
    }
    if (options.lead.email) {
      doc.setTextColor(100, 100, 100);
      doc.text(options.lead.email, 16, y);
      y += 5;
    }
    if (options.lead.phone || options.lead.mobile) {
      doc.text(options.lead.phone || options.lead.mobile || "", 16, y);
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
      fillColor: BRAND_TEAL,
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 10,
    },
    alternateRowStyles: {
      fillColor: [240, 250, 245],
    },
    bodyStyles: { fontSize: 9, textColor: BRAND_DARK },
    columnStyles: {
      0: { cellWidth: 12, halign: "center" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 16, halign: "center" },
      3: { cellWidth: 38, halign: "right" },
      4: { cellWidth: 38, halign: "right" },
    },
    margin: { left: 14, right: 14 },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // ── Totals Section ──
  const totalsX = pageWidth - 85;
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
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line(totalsX, y, totalsValueX, y);
  y += 7;

  // Total amount with teal background
  doc.setFillColor(...BRAND_TEAL);
  doc.roundedRect(totalsX - 2, y - 5, totalsValueX - totalsX + 4, 10, 2, 2, "F");
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("Total:", totalsX + 2, y + 1);
  doc.text(formatCurrencyPDF(options.totalAmount), totalsValueX - 2, y + 1, {
    align: "right",
  });
  y += 14;

  // ── Terms & Conditions ──
  if (options.termsAndConditions) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Terms & Conditions", 14, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
    const tcLines = doc.splitTextToSize(
      options.termsAndConditions,
      pageWidth - 28
    );
    doc.text(tcLines, 14, y);
    y += tcLines.length * 4.5 + 6;
  }

  // ── Bank Details ──
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Bank Details", 14, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  const bankLines = [
    `Account Name: ${COMPANY_BANK_DETAILS.accountName}`,
    `Account Number: ${COMPANY_BANK_DETAILS.accountNumber}`,
    `IFSC Code: ${COMPANY_BANK_DETAILS.ifscCode}`,
    `Bank: ${COMPANY_BANK_DETAILS.bank}`,
    `Branch: ${COMPANY_BANK_DETAILS.branch}`,
  ];
  bankLines.forEach((line) => {
    doc.text(line, 14, y);
    y += 4.5;
  });
  y += 6;

  // ── Notes ──
  if (options.notes) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Notes", 14, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
    const notesLines = doc.splitTextToSize(options.notes, pageWidth - 28);
    doc.text(notesLines, 14, y);
  }

  // ── Footer ──
  const pageHeight = doc.internal.pageSize.getHeight();
  const footerH = 20;
  const footerY = pageHeight - footerH;

  // Footer teal bar
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, footerY, pageWidth, footerH, "F");

  // Thin green accent line at top of footer
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, footerY, pageWidth, 0.8, "F");

  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text(
    `${BRAND_NAME}  |  ${COMPANY_NAME}`,
    pageWidth / 2,
    footerY + 6,
    { align: "center" }
  );

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(200, 230, 220);
  doc.text(
    `${COMPANY_ADDRESS.join(" ")}  |  ${COMPANY_PHONE}  |  ${COMPANY_WEBSITE}`,
    pageWidth / 2,
    footerY + 11,
    { align: "center" }
  );
  doc.text(
    COMPANY_GST,
    pageWidth / 2,
    footerY + 16,
    { align: "center" }
  );

  return doc;
}

export function generateProposalPDF(
  proposal: Proposal,
  lead?: Partial<Lead>
): jsPDF {
  return generatePDF({
    title: "PRO-FORMA INVOICE / PROPOSAL",
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
    description: [proposal.title, proposal.description].filter(Boolean).join("\n"),
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

export function generateContractPDF(
  contract: Contract,
  lead?: Partial<Lead>
): jsPDF {
  const contractDetails = [
    `Billing Cycle: ${BILLING_CYCLE_LABELS[contract.billing_cycle] || contract.billing_cycle}`,
    `Tenure: ${contract.tenure_months} months`,
    `Start Date: ${formatDatePDF(contract.start_date)}`,
    `End Date: ${formatDatePDF(contract.end_date)}`,
    `Seats: ${contract.seats}`,
  ].join("  |  ");

  return generatePDF({
    title: "CONTRACT",
    documentNumber: contract.contract_number,
    items: contract.items,
    subtotal: contract.subtotal,
    taxPercentage: contract.tax_percentage,
    taxAmount: contract.tax_amount,
    discountPercentage: contract.discount_percentage,
    discountAmount: contract.discount_amount,
    totalAmount: contract.total_amount,
    lead,
    createdAt: contract.created_at,
    description: contractDetails,
    termsAndConditions: contract.terms_and_conditions,
    notes: contract.notes,
  });
}

export function generateBillingStatementPDF(
  statement: BillingStatement,
  contract?: Partial<Contract>,
  lead?: Partial<Lead>,
  usageCharges?: { description: string; quantity: number; unit_price: number; total: number; charge_date: string }[]
): jsPDF {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header
  let y = addLogoToDoc(doc);

  // Divider
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageWidth - 14, y);
  y += 10;

  // Title
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("BILLING STATEMENT", 14, y);

  // Statement number — right aligned
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text(statement.statement_number, pageWidth - 14, y, { align: "right" });
  y += 7;

  // Period
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Period: ${formatDatePDF(statement.period_start)} - ${formatDatePDF(statement.period_end)}`, pageWidth - 14, y, { align: "right" });
  y += 8;

  // Lead info
  if (lead) {
    doc.setFillColor(240, 250, 245);
    doc.rect(14, y - 4, pageWidth - 28, 6, "F");
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("CUSTOMER", 16, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BRAND_DARK);
    const leadName = `${lead.first_name || ""} ${lead.last_name || ""}`.trim();
    if (leadName) {
      doc.setFont("helvetica", "bold");
      doc.text(leadName, 16, y);
      doc.setFont("helvetica", "normal");
      y += 5;
    }
    if (lead.company) {
      doc.text(lead.company, 16, y);
      y += 5;
    }
    y += 4;
  }

  // Contract reference
  if (contract?.contract_number) {
    doc.setFontSize(9);
    doc.setTextColor(100, 100, 100);
    doc.text(`Contract: ${contract.contract_number} — ${contract.title || ""}`, 14, y);
    y += 8;
  }

  // Section 1: Fixed Charges
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Fixed Charges", 14, y);
  y += 4;

  autoTable(doc, {
    startY: y,
    head: [["Description", "Amount"]],
    body: [["Recurring charge (contract)", formatCurrencyPDF(statement.fixed_amount)]],
    theme: "striped",
    headStyles: { fillColor: BRAND_TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 10 },
    bodyStyles: { fontSize: 9, textColor: BRAND_DARK },
    margin: { left: 14, right: 14 },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // Section 2: Usage Charges (if any)
  if (usageCharges && usageCharges.length > 0) {
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Additional Usage Charges", 14, y);
    y += 4;

    const usageRows = usageCharges.map((c, i) => [
      String(i + 1),
      c.description,
      String(c.quantity),
      formatCurrencyPDF(c.unit_price),
      formatCurrencyPDF(c.total),
    ]);

    autoTable(doc, {
      startY: y,
      head: [["#", "Description", "Qty", "Rate", "Total"]],
      body: usageRows,
      theme: "striped",
      headStyles: { fillColor: BRAND_TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 10 },
      alternateRowStyles: { fillColor: [240, 250, 245] },
      bodyStyles: { fontSize: 9, textColor: BRAND_DARK },
      columnStyles: {
        0: { cellWidth: 12, halign: "center" },
        1: { cellWidth: "auto" },
        2: { cellWidth: 16, halign: "center" },
        3: { cellWidth: 38, halign: "right" },
        4: { cellWidth: 38, halign: "right" },
      },
      margin: { left: 14, right: 14 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // Summary totals
  const totalsX = pageWidth - 85;
  const totalsValueX = pageWidth - 14;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);

  doc.text("Fixed Amount:", totalsX, y);
  doc.text(formatCurrencyPDF(statement.fixed_amount), totalsValueX, y, { align: "right" });
  y += 6;

  doc.text("Usage Amount:", totalsX, y);
  doc.text(formatCurrencyPDF(statement.usage_amount), totalsValueX, y, { align: "right" });
  y += 6;

  doc.text("Subtotal:", totalsX, y);
  doc.text(formatCurrencyPDF(statement.subtotal), totalsValueX, y, { align: "right" });
  y += 6;

  if (statement.tax_percentage > 0) {
    doc.text(`Tax (${statement.tax_percentage}%):`, totalsX, y);
    doc.text(formatCurrencyPDF(statement.tax_amount), totalsValueX, y, { align: "right" });
    y += 6;
  }

  // Total line
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line(totalsX, y, totalsValueX, y);
  y += 7;

  // Total amount with teal background
  doc.setFillColor(...BRAND_TEAL);
  doc.roundedRect(totalsX - 2, y - 5, totalsValueX - totalsX + 4, 10, 2, 2, "F");
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("Total:", totalsX + 2, y + 1);
  doc.text(formatCurrencyPDF(statement.total_amount), totalsValueX - 2, y + 1, { align: "right" });
  y += 14;

  // Bank Details
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Bank Details", 14, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  const bsBankLines = [
    `Account Name: ${COMPANY_BANK_DETAILS.accountName}`,
    `Account Number: ${COMPANY_BANK_DETAILS.accountNumber}`,
    `IFSC Code: ${COMPANY_BANK_DETAILS.ifscCode}`,
    `Bank: ${COMPANY_BANK_DETAILS.bank}`,
    `Branch: ${COMPANY_BANK_DETAILS.branch}`,
  ];
  bsBankLines.forEach((line) => {
    doc.text(line, 14, y);
    y += 4.5;
  });
  y += 6;

  // Note
  doc.setFontSize(8);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(120, 120, 120);
  doc.text("This is a billing compilation for internal use. GST invoice to be issued separately.", 14, y);

  // Footer
  const pageHeight = doc.internal.pageSize.getHeight();
  const footerH = 20;
  const footerY = pageHeight - footerH;
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, footerY, pageWidth, footerH, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, footerY, pageWidth, 0.8, "F");
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text(`${BRAND_NAME}  |  ${COMPANY_NAME}`, pageWidth / 2, footerY + 6, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(200, 230, 220);
  doc.text(`${COMPANY_ADDRESS.join(" ")}  |  ${COMPANY_PHONE}  |  ${COMPANY_WEBSITE}`, pageWidth / 2, footerY + 11, { align: "center" });
  doc.text(COMPANY_GST, pageWidth / 2, footerY + 16, { align: "center" });

  return doc;
}

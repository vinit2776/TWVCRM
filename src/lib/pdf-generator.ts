import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { Proposal, ProformaInvoice, Lead, LineItem, Contract, BillingStatement, Location } from "@/types";
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
    item.unit || "",
    formatCurrencyPDF(item.unit_price),
    formatCurrencyPDF(item.total),
  ]);

  autoTable(doc, {
    startY: y,
    head: [["#", "Description", "Qty", "Unit", "Unit Price", "Total"]],
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

// ================================================================
// Membership Agreement PDF Generator
// ================================================================

function numberToWords(num: number): string {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (num === 0) return "Zero";
  if (num < 0) return "Minus " + numberToWords(-num);
  let words = "";
  if (Math.floor(num / 10000000) > 0) {
    words += numberToWords(Math.floor(num / 10000000)) + " Crore ";
    num %= 10000000;
  }
  if (Math.floor(num / 100000) > 0) {
    words += numberToWords(Math.floor(num / 100000)) + " Lakh ";
    num %= 100000;
  }
  if (Math.floor(num / 1000) > 0) {
    words += numberToWords(Math.floor(num / 1000)) + " Thousand ";
    num %= 1000;
  }
  if (Math.floor(num / 100) > 0) {
    words += ones[Math.floor(num / 100)] + " Hundred ";
    num %= 100;
  }
  if (num > 0) {
    if (words !== "") words += "and ";
    if (num < 20) {
      words += ones[num];
    } else {
      words += tens[Math.floor(num / 10)];
      if (num % 10 > 0) words += " " + ones[num % 10];
    }
  }
  return words.trim();
}

function amountInWords(amount: number): string {
  const rupees = Math.floor(amount);
  return "Rupees " + numberToWords(rupees) + " Only";
}

export function generateMembershipAgreementPDF(
  contract: Contract,
  lead?: Partial<Lead>,
  location?: Partial<Location>
): jsPDF {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 15;
  const marginRight = 15;
  const contentWidth = pageWidth - marginLeft - marginRight;
  const maxY = pageHeight - 20;
  let y = 0;

  const memberName = lead?.company || "The Member";
  const panNumber = lead?.pan_number || "___________";
  const memberAddress = [lead?.street, lead?.city, lead?.state, lead?.zip_code, lead?.country]
    .filter(Boolean).join(", ") || "___________";

  const monthlyFee = contract.total_amount || 0;
  const securityDepositMonths = contract.security_deposit_months || 3;
  const ifrsd = monthlyFee * securityDepositMonths;
  const escalation = contract.escalation_percentage || 10;
  const noticePeriod = contract.notice_period_months || 2;
  const commitmentTerm = Math.max(0, contract.tenure_months - noticePeriod);
  const locationName = location?.name || "The WorkVilla";
  const locationAddress = [location?.address, location?.city, location?.state].filter(Boolean).join(", ") || "Chennai";

  function checkPageBreak(needed: number): void {
    if (y + needed > maxY) {
      doc.addPage();
      y = 20;
    }
  }

  function addWrappedText(text: string, x: number, width: number, fontSize: number, style: string = "normal", color: [number, number, number] = [50, 50, 50], lineHeight: number = 5): void {
    doc.setFontSize(fontSize);
    doc.setFont("helvetica", style);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, width);
    for (const line of lines) {
      checkPageBreak(lineHeight + 2);
      doc.text(line, x, y);
      y += lineHeight;
    }
  }

  // ================================================================
  // PAGE 1: HEADER & PREAMBLE
  // ================================================================

  // Teal header bar
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 25, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 25, pageWidth, 1.5, "F");

  // Logo in header
  doc.addImage(TWV_LOGO_BASE64, "PNG", marginLeft, 5, 50, 12.5);

  // Company details in header (right side)
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(255, 255, 255);
  doc.text(COMPANY_NAME, pageWidth - marginRight, 10, { align: "right" });
  doc.text(COMPANY_ADDRESS.join(" "), pageWidth - marginRight, 14, { align: "right" });
  doc.text(`${COMPANY_PHONE} | ${COMPANY_WEBSITE}`, pageWidth - marginRight, 18, { align: "right" });

  y = 38;

  // Title
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("MEMBERSHIP AGREEMENT", pageWidth / 2, y, { align: "center" });
  y += 3;

  // Underline
  const titleWidth = doc.getTextWidth("MEMBERSHIP AGREEMENT");
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line((pageWidth - titleWidth) / 2, y, (pageWidth + titleWidth) / 2, y);
  y += 10;

  // Agreement date line
  const agreementDate = contract.agreement_date ? formatDatePDF(contract.agreement_date) : formatDatePDF(contract.created_at);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Date: ${agreementDate}`, pageWidth - marginRight, y, { align: "right" });
  doc.text(`Ref: ${contract.contract_number}`, marginLeft, y);
  y += 10;

  // Preamble
  const preamble = `This Membership Agreement ("Agreement") is entered into on ${agreementDate} by and between:`;
  addWrappedText(preamble, marginLeft, contentWidth, 10, "normal", [50, 50, 50], 5);
  y += 4;

  // Party 1 — Company
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("PARTY OF THE FIRST PART (Operator):", marginLeft, y);
  y += 6;

  const companyPartyText = `SREE DESIGN INFRASTRUCTURE PRIVATE LIMITED, a company incorporated under the Companies Act, 2013, having its registered office at Prakash Presidium, 110, Mahatma Gandhi Road, Nungambakkam, Chennai - 600034 (PAN: AAACU4245J), hereinafter referred to as "The WorkVilla" or "Operator" (which expression shall, unless repugnant to the context or meaning thereof, mean and include its successors and assigns).`;
  addWrappedText(companyPartyText, marginLeft, contentWidth, 9, "normal", [50, 50, 50], 4.5);
  y += 4;

  // Party 2 — Member
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  checkPageBreak(10);
  doc.text("PARTY OF THE SECOND PART (Member):", marginLeft, y);
  y += 6;

  const signatoryClause = contract.member_signatory_name
    ? `, represented herein by ${contract.member_signatory_name}, ${contract.member_signatory_designation || "Authorised Signatory"}${contract.member_signatory_pan ? ` (PAN: ${contract.member_signatory_pan})` : ""}, duly authorised to execute this Agreement`
    : "";
  const memberPartyText = `${memberName}, a company having its registered office at ${memberAddress} (PAN: ${panNumber})${signatoryClause}, hereinafter referred to as "Member" (which expression shall, unless repugnant to the context or meaning thereof, mean and include its successors and assigns).`;
  addWrappedText(memberPartyText, marginLeft, contentWidth, 9, "normal", [50, 50, 50], 4.5);
  y += 4;

  // Whereas clause
  const whereasText = `WHEREAS the Operator owns and operates managed workspace facilities under the brand name "The WorkVilla" and the Member desires to avail the workspace services offered by the Operator, subject to the terms and conditions set out herein.`;
  addWrappedText(whereasText, marginLeft, contentWidth, 9, "normal", [50, 50, 50], 4.5);
  y += 4;

  const nowThereforeText = `NOW THEREFORE, in consideration of the mutual covenants, promises and agreements contained herein, the parties agree as follows:`;
  addWrappedText(nowThereforeText, marginLeft, contentWidth, 9, "bold", [50, 50, 50], 4.5);
  y += 6;

  // ================================================================
  // SCHEDULE TABLE
  // ================================================================

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  checkPageBreak(15);
  doc.text("SCHEDULE", pageWidth / 2, y, { align: "center" });
  y += 8;

  const scheduleData: [string, string, string][] = [
    ["1", "Location / Premises", `${locationName}\n${locationAddress}`],
    ["2", "Work Space Description", contract.workspace_description || "As per agreement"],
    ["3", "Parking Space", contract.parking_space || "Nil"],
    ["4", "Inclusions", "Wi-Fi Broadband Internet, Electricity & Power Backup, Housekeeping, Drinking Water, Tea / Coffee (self-service), Common Area Maintenance"],
    ["5", "Complimentary Services", contract.complimentary_services || "Nil"],
    ["6", "Additional Paid Services", "Conference Room, Meeting Room, Printing/Scanning/Photocopying, Courier, Pantry Services (as per menu), Event Space -- all billed at prevailing rates"],
    ["7", "Rack Rate", "As published by the Operator from time to time"],
    ["8", "Monthly Membership Fees (MMF)", `${formatCurrencyPDF(monthlyFee)} + GST per month\n(${amountInWords(monthlyFee)})`],
    ["9", "Commencement Date", formatDatePDF(contract.start_date)],
    ["10", "Term", `${contract.tenure_months} months from the Commencement Date`],
    ["11", "Commitment Term (Lock-in)", `${commitmentTerm} months from the Commencement Date`],
    ["12", "Centre Timings", "Monday to Saturday: 9:00 AM to 7:00 PM\nSundays & National Holidays: Closed\n24/7 Access available for dedicated desk and private office members"],
    ["13", "Interest Free Refundable\nSecurity Deposit (IFRSD)", `${securityDepositMonths} x MMF = ${formatCurrencyPDF(ifrsd)} + GST\n(${amountInWords(ifrsd)})`],
    ["14", "Payment Due Upon Signing", `IFRSD + First Month's MMF (pro-rated if applicable) + Rs. 20,000 towards GST Registration (refundable upon providing own GST)`],
    ["15", "Move-In Formalities", "Signed Agreement, KYC Documents (as per Enclosure), IFRSD & First Month's payment"],
    ["16", "Payment Terms", "Monthly in advance, due on or before the 5th of every calendar month via NEFT/RTGS/Cheque"],
  ];

  autoTable(doc, {
    startY: y,
    head: [["No.", "Description", "Details"]],
    body: scheduleData,
    theme: "grid",
    headStyles: {
      fillColor: BRAND_TEAL,
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 9,
      cellPadding: 4,
    },
    bodyStyles: {
      fontSize: 8.5,
      textColor: [50, 50, 50],
      cellPadding: 3.5,
      lineColor: [200, 200, 200],
      lineWidth: 0.3,
    },
    alternateRowStyles: {
      fillColor: [245, 250, 248],
    },
    columnStyles: {
      0: { cellWidth: 12, halign: "center", fontStyle: "bold" },
      1: { cellWidth: 50, fontStyle: "bold" },
      2: { cellWidth: "auto" },
    },
    margin: { left: marginLeft, right: marginRight },
    didParseCell: (data) => {
      if (data.column.index === 2 && [7, 12].includes(data.row.index)) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 6;

  // Continue schedule rows 17-19
  const scheduleData2: [string, string, string][] = [
    ["17", "Modifications & Additions", "Any modifications to the workspace layout or additional fit-outs requested by the Member shall be subject to prior written approval of the Operator and at the Member's cost."],
    ["18", "Auto-Renewal", `This Agreement shall automatically renew for successive terms of ${contract.tenure_months} months each upon expiry, unless either party provides written notice of non-renewal at least ${noticePeriod} month(s) prior to the end of the then-current term.`],
    ["19", "Escalation", `The MMF shall be subject to an annual escalation of ${escalation}% effective from each anniversary of the Commencement Date.`],
  ];

  checkPageBreak(30);

  autoTable(doc, {
    startY: y,
    body: scheduleData2,
    theme: "grid",
    bodyStyles: {
      fontSize: 8.5,
      textColor: [50, 50, 50],
      cellPadding: 3.5,
      lineColor: [200, 200, 200],
      lineWidth: 0.3,
    },
    alternateRowStyles: {
      fillColor: [245, 250, 248],
    },
    columnStyles: {
      0: { cellWidth: 12, halign: "center", fontStyle: "bold" },
      1: { cellWidth: 50, fontStyle: "bold" },
      2: { cellWidth: "auto" },
    },
    margin: { left: marginLeft, right: marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 10;

  // ================================================================
  // TERMS AND CONDITIONS (Clauses 20-36)
  // ================================================================

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  checkPageBreak(15);
  doc.text("TERMS AND CONDITIONS", pageWidth / 2, y, { align: "center" });
  y += 8;

  const clauses: [string, string, string][] = [
    ["20", "Use of Premises", "The Member shall use the allocated workspace solely for lawful business purposes. The Member shall not use the premises for any illegal, immoral, or objectionable purpose. The Member shall comply with all applicable laws, rules, and regulations in the conduct of its business from the premises."],
    ["21", "Maintenance & Housekeeping", "The Operator shall maintain the common areas and provide regular housekeeping services. The Member shall maintain its allocated workspace in a clean and orderly condition. Any damage caused by the Member or its invitees to the premises, furniture, fixtures, or equipment shall be repaired/replaced at the Member's cost."],
    ["22", "Code of Conduct", "The Member and its employees, agents, and invitees shall observe and comply with the rules, regulations, and code of conduct prescribed by the Operator from time to time. The Operator reserves the right to deny entry to any person who does not comply with the same."],
    ["23", "Termination", `Either party may terminate this Agreement by giving ${noticePeriod} month(s) written notice after the expiry of the Commitment Term. Early termination by the Member during the Commitment Term shall result in forfeiture of the IFRSD. The Operator may terminate this Agreement immediately upon: (a) breach of any material term by the Member; (b) default in payment for more than 15 days; (c) insolvency or winding up of the Member.`],
    ["24", "Consequences of Termination", "Upon termination: (a) the Member shall vacate the premises and remove all its belongings within 7 days; (b) the IFRSD (or balance thereof) shall be refunded within 30 days after adjusting any outstanding dues; (c) any property left behind after 15 days of termination shall be deemed abandoned."],
    ["25", "Security Deposit", `The IFRSD of ${formatCurrencyPDF(ifrsd)} shall be held by the Operator as security for the Member's obligations. No interest shall accrue on the IFRSD. The Operator may apply the IFRSD towards any outstanding dues upon termination.`],
    ["26", "Late Payment", "A late payment charge of 2% per month (or part thereof) shall be levied on any amount outstanding beyond the due date. The Operator reserves the right to restrict access to the premises if payment is overdue by more than 15 days."],
    ["27", "Insurance & Liability", "The Operator shall maintain adequate insurance for the building and common areas. The Member shall be responsible for insuring its own equipment, inventory, and belongings. The Operator shall not be liable for any loss, damage, or theft of the Member's property."],
    ["28", "Company Details", `Operator: SREE DESIGN INFRASTRUCTURE PRIVATE LIMITED\nCIN: U74999TN2014PTC097266\nGST: 33AAACU4245J1ZF\nRegistered Office: ${COMPANY_ADDRESS.join(" ")}`],
    ["29", "Bank Details", `Account Name: ${COMPANY_BANK_DETAILS.accountName}\nAccount No: ${COMPANY_BANK_DETAILS.accountNumber}\nIFSC: ${COMPANY_BANK_DETAILS.ifscCode}\nBank: ${COMPANY_BANK_DETAILS.bank}\nBranch: ${COMPANY_BANK_DETAILS.branch}`],
    ["30", "Confidentiality", "Both parties shall maintain confidentiality of the terms of this Agreement and any proprietary or confidential information of the other party that comes to its knowledge during the term of this Agreement."],
    ["31", "Force Majeure", "Neither party shall be liable for any failure or delay in performance due to circumstances beyond its reasonable control, including but not limited to natural disasters, war, epidemic/pandemic, government action, or failure of utilities."],
    ["32", "Indemnity", "The Member shall indemnify and hold harmless the Operator against all claims, liabilities, damages, costs, and expenses arising from: (a) the Member's use of the premises; (b) any breach of this Agreement by the Member; (c) any act or omission of the Member or its employees, agents, or invitees."],
    ["33", "Dispute Resolution", "Any dispute arising out of or in connection with this Agreement shall first be attempted to be resolved through mutual discussions. Failing which, the dispute shall be referred to arbitration under the Arbitration and Conciliation Act, 1996. The seat of arbitration shall be Chennai, Tamil Nadu."],
    ["34", "Governing Law & Jurisdiction", "This Agreement shall be governed by and construed in accordance with the laws of India. The courts at Chennai shall have exclusive jurisdiction over any disputes arising hereunder."],
    ["35", "Entire Agreement", "This Agreement constitutes the entire agreement between the parties with respect to the subject matter hereof and supersedes all prior agreements, understandings, negotiations, and discussions, whether oral or written."],
    ["36", "Amendments", "No amendment, modification, or waiver of any provision of this Agreement shall be effective unless made in writing and signed by both parties."],
  ];

  for (const [num, title, body] of clauses) {
    checkPageBreak(20);

    doc.setFontSize(9.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text(`${num}. ${title}`, marginLeft, y);
    y += 5;

    addWrappedText(body, marginLeft, contentWidth, 8.5, "normal", [50, 50, 50], 4);
    y += 4;
  }

  // ================================================================
  // SIGNATURE BLOCK
  // ================================================================

  checkPageBreak(60);
  y += 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  const witnessText = "IN WITNESS WHEREOF, the parties have executed this Agreement on the date first written above.";
  const witnessLines = doc.splitTextToSize(witnessText, contentWidth);
  doc.text(witnessLines, marginLeft, y);
  y += witnessLines.length * 5 + 8;

  // Two-column signature block
  const colWidth = (contentWidth - 20) / 2;
  const col1X = marginLeft;
  const col2X = marginLeft + colWidth + 20;

  // Operator side
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("For SREE DESIGN INFRASTRUCTURE", col1X, y);
  doc.text("PRIVATE LIMITED", col1X, y + 4);

  // Member side
  const memberLines = doc.splitTextToSize(`For ${memberName}`, colWidth);
  doc.text(memberLines, col2X, y);
  y += 25;

  // Signature lines
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.3);
  doc.line(col1X, y, col1X + colWidth, y);
  doc.line(col2X, y, col2X + colWidth, y);
  y += 5;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_DARK);
  doc.text("Authorized Signatory", col1X, y);
  doc.text("Authorized Signatory", col2X, y);
  y += 5;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("Name: NAVAL CHORDIA", col1X, y);
  doc.text(`Name: ${contract.member_signatory_name || "___________"}`, col2X, y);
  y += 5;
  doc.text("Designation: Director", col1X, y);
  doc.text(`Designation: ${contract.member_signatory_designation || "___________"}`, col2X, y);
  y += 5;
  doc.text(`Date: ${agreementDate}`, col1X, y);
  doc.text(`Date: ${agreementDate}`, col2X, y);
  y += 5;
  doc.text("Place: Chennai", col1X, y);
  doc.text("Place: ___________", col2X, y);
  y += 12;

  // ================================================================
  // ENCLOSURE: KYC REQUIREMENTS
  // ================================================================

  checkPageBreak(50);

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("ENCLOSURE: KYC Documents Required", marginLeft, y);
  y += 8;

  const kycItems = [
    "Copy of PAN Card of the Company / LLP / Firm / Individual",
    "Copy of GST Registration Certificate (if applicable)",
    "Copy of Certificate of Incorporation / Partnership Deed",
    "Copy of Board Resolution / Authorization Letter for the Authorized Signatory",
    "Copy of PAN Card & Aadhaar Card of the Authorized Signatory",
    "Passport-size photograph of the Authorized Signatory",
    "List of employees / users who will be using the workspace (with photo ID)",
    "Cancelled cheque or bank statement (for NEFT/RTGS payment setup)",
  ];

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(50, 50, 50);

  kycItems.forEach((item, i) => {
    checkPageBreak(8);
    doc.setDrawColor(150, 150, 150);
    doc.setLineWidth(0.3);
    doc.rect(marginLeft, y - 3, 3, 3);
    doc.text(`${i + 1}. ${item}`, marginLeft + 6, y);
    y += 6;
  });

  // ================================================================
  // Add branded footer to all pages
  // ================================================================

  const totalPageCount = doc.getNumberOfPages();
  for (let i = 1; i <= totalPageCount; i++) {
    doc.setPage(i);
    const ph = doc.internal.pageSize.getHeight();
    const pw = doc.internal.pageSize.getWidth();

    doc.setFillColor(...BRAND_TEAL);
    doc.rect(0, ph - 14, pw, 14, "F");
    doc.setFillColor(...BRAND_GREEN);
    doc.rect(0, ph - 14, pw, 0.8, "F");

    doc.setFontSize(6.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(`${BRAND_NAME}  |  ${COMPANY_NAME}`, pw / 2, ph - 8, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(6);
    doc.setTextColor(200, 230, 220);
    doc.text(`Page ${i} of ${totalPageCount}  |  ${COMPANY_WEBSITE}`, pw / 2, ph - 4, { align: "center" });
  }

  return doc;
}

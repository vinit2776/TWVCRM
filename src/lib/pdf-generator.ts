import jsPDF, { GState } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Proposal, ProformaInvoice, Lead, LineItem, Contract, BillingStatement, Location } from "@/types";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";
import { BILLING_CYCLE_LABELS, COMPANY_BANK_DETAILS } from "@/lib/constants";
import { computePhaseBoundaries, formatDateRange } from "@/lib/rate-phase-dates";
import { drawCompanyStamp } from "@/lib/company-stamp";

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

// usage_charges.quantity is a consumption ledger (drives free-quota
// accounting on the checkout pooled-usage path) and is NOT always what the
// customer is billed for — billed_quantity is. Invoice/statement line
// items must render billed_quantity when present, falling back to
// quantity for historical rows inserted before that column existed.
// `LineItem` (from @/types) doesn't declare billed_quantity since it's
// shared with proposal/contract line items that don't have the concept,
// so callers pass it through as an untyped extra field.
function displayQty(quantity: number, billedQuantity?: number | null): string {
  return String(billedQuantity ?? quantity);
}

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

// jsPDF's built-in "helvetica" font only supports WinAnsiEncoding (Latin-1).
// Free-text fields (terms, notes, descriptions) can contain characters typed
// or pasted by users — like ₹ or smart typography from Word/Docs — that fall
// outside that range. Left unhandled, a single such character throws off
// jsPDF's line-width calculation for the whole line it's in, producing
// stretched-out spacing and clipped/missing text. Sanitize before rendering.
function sanitizeForPdf(text: string): string {
  return text
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x00-\xFF]/g, "");
}

function formatDatePDF(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
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
  location?: Partial<Location>;
  createdAt: string;
  validUntil?: string;
  dueDate?: string;
  description?: string;
  descriptionLabel?: string;
  termsAndConditions?: string;
  notes?: string;
  notesLabel?: string;
  qrCodeBase64?: string; // Base64 image data (PNG/JPEG) for UPI QR code
  upiId?: string; // UPI ID text to show alongside QR
  razorpayPaymentLink?: string; // Razorpay payment link URL
  preparedBy?: { name: string; email?: string; phone?: string }; // Sales rep info
  showServicesIncluded?: boolean; // Show the "What's Included" icon strip (proposals only)
  amenityIcons?: string[]; // Icon keys to show in the amenities strip (falls back to default 4)
  serviceQuotas?: { name: string; unit_label: string; monthly_quota: number; overage_rate: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// "What's Included" service icon strip — drawn with jsPDF primitives so no
// external icon font or image assets are required.
// All icon functions accept (cx, cy) as the visual centre of the icon and
// s as the icon half-size (radius) in mm.
// ─────────────────────────────────────────────────────────────────────────────

/** Draw a series of line segments approximating an arc of a circle. */
function arcSegments(
  doc: jsPDF,
  cx: number, cy: number, r: number,
  startDeg: number, endDeg: number,
  steps = 16
): void {
  for (let i = 0; i < steps; i++) {
    const a1 = ((startDeg + (endDeg - startDeg) * i / steps) * Math.PI) / 180;
    const a2 = ((startDeg + (endDeg - startDeg) * (i + 1) / steps) * Math.PI) / 180;
    doc.line(
      cx + r * Math.cos(a1), cy + r * Math.sin(a1),
      cx + r * Math.cos(a2), cy + r * Math.sin(a2)
    );
  }
}

/** Wi-Fi arcs (3 concentric arcs opening upward + centre dot). */
function iconWifi(doc: jsPDF, cx: number, cy: number, s: number): void {
  doc.setDrawColor(...BRAND_TEAL);
  doc.setFillColor(...BRAND_TEAL);
  doc.setLineWidth(0.55);
  // Centre dot sits at the bottom of the symbol
  doc.circle(cx, cy + s * 0.18, s * 0.1, "F");
  // Three arcs — 210° → 330° puts them opening upward in jsPDF's Y-down coords
  [0.36, 0.63, 0.90].forEach((rf) =>
    arcSegments(doc, cx, cy + s * 0.18, s * rf, 210, 330)
  );
}

/** Pantry / coffee cup (body, handle, saucer, three steam dots). */
function iconCoffee(doc: jsPDF, cx: number, cy: number, s: number): void {
  doc.setDrawColor(...BRAND_TEAL);
  doc.setFillColor(...BRAND_TEAL);
  doc.setLineWidth(0.55);
  const bw = s * 0.9, bh = s * 0.9;
  // Cup body
  doc.rect(cx - bw / 2, cy - bh * 0.28, bw, bh, "S");
  // Handle — C-curve on the right side (-75° → 75°)
  arcSegments(doc, cx + bw / 2, cy + bh * 0.22, s * 0.28, -75, 75, 14);
  // Saucer line
  doc.setLineWidth(0.7);
  doc.line(cx - bw * 0.65, cy + bh * 0.72, cx + bw * 0.65, cy + bh * 0.72);
  // Steam dots (three small filled circles above cup)
  doc.setLineWidth(0.55);
  [-0.28, 0, 0.28].forEach((dx) =>
    doc.circle(cx + dx * s, cy - bh * 0.48, s * 0.07, "F")
  );
}

/** Printer (input tray, filled body with green LED, output paper). */
function iconPrinter(doc: jsPDF, cx: number, cy: number, s: number): void {
  const bw = s * 1.2, bh = s * 0.62, pw = s * 0.72;
  doc.setFillColor(...BRAND_TEAL);
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.55);
  // Input paper tray (top, stroked only)
  doc.rect(cx - pw / 2, cy - bh / 2 - s * 0.28, pw, s * 0.28, "S");
  // Printer body (filled)
  doc.rect(cx - bw / 2, cy - bh / 2, bw, bh, "F");
  // Paper-slot highlight (white slot on front of body)
  doc.setFillColor(255, 255, 255);
  doc.rect(cx - pw / 2 + s * 0.07, cy + bh / 2 - s * 0.1, pw - s * 0.14, s * 0.1, "F");
  doc.setFillColor(...BRAND_TEAL);
  // Output paper hanging below (stroked)
  doc.rect(cx - pw / 2 + s * 0.07, cy + bh / 2, pw - s * 0.14, s * 0.3, "S");
  // Green status LED on top-right of body
  doc.setFillColor(...BRAND_GREEN);
  doc.circle(cx + bw / 2 - s * 0.23, cy - s * 0.04, s * 0.09, "F");
  doc.setFillColor(...BRAND_TEAL);
}

/** Conference room (filled table + 6 seat circles). */
function iconMeeting(doc: jsPDF, cx: number, cy: number, s: number): void {
  doc.setFillColor(...BRAND_TEAL);
  doc.setDrawColor(...BRAND_TEAL);
  doc.roundedRect(cx - s * 0.5, cy - s * 0.22, s * 1.0, s * 0.44, s * 0.08, s * 0.08, "F");
  const r = s * 0.12;
  [
    [cx - s * 0.28, cy - s * 0.58],
    [cx + s * 0.28, cy - s * 0.58],
    [cx - s * 0.28, cy + s * 0.58],
    [cx + s * 0.28, cy + s * 0.58],
    [cx - s * 0.70, cy],
    [cx + s * 0.70, cy],
  ].forEach(([px, py]) => doc.circle(px, py, r, "F"));
}

/** Power backup — battery outline with lightning bolt inside. */
function iconPowerBackup(doc: jsPDF, cx: number, cy: number, s: number): void {
  doc.setDrawColor(...BRAND_TEAL);
  doc.setFillColor(...BRAND_TEAL);
  doc.setLineWidth(0.55);
  // Battery body
  const bw = s * 1.1, bh = s * 0.65;
  doc.rect(cx - bw / 2, cy - bh / 2, bw, bh, "S");
  // Battery terminal nub on the right
  const nw = s * 0.15, nh = s * 0.35;
  doc.rect(cx + bw / 2, cy - nh / 2, nw, nh, "F");
  // Lightning bolt — two lines forming a zigzag
  doc.setLineWidth(0.8);
  doc.line(cx + s * 0.08, cy - bh * 0.38, cx - s * 0.12, cy + s * 0.04);
  doc.line(cx - s * 0.12, cy + s * 0.04, cx + s * 0.12, cy + s * 0.04);
  doc.line(cx + s * 0.12, cy + s * 0.04, cx - s * 0.08, cy + bh * 0.38);
}

/** Parking — filled circle with a bold "P". */
function iconParking(doc: jsPDF, cx: number, cy: number, s: number): void {
  doc.setFillColor(...BRAND_TEAL);
  doc.setDrawColor(...BRAND_TEAL);
  doc.circle(cx, cy, s * 0.85, "F");
  doc.setFontSize(s * 3.8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("P", cx, cy + s * 0.42, { align: "center" });
  doc.setTextColor(...BRAND_TEAL);
}

/** CCTV / Security — camera body with lens and mounting bracket. */
function iconCCTV(doc: jsPDF, cx: number, cy: number, s: number): void {
  doc.setDrawColor(...BRAND_TEAL);
  doc.setFillColor(...BRAND_TEAL);
  doc.setLineWidth(0.55);
  // Camera body (tilted slightly — trapezoid via lines)
  const bw = s * 1.0, bh = s * 0.55;
  doc.rect(cx - bw / 2, cy - bh / 2 + s * 0.1, bw, bh, "F");
  // Lens — white circle on the left face of body
  doc.setFillColor(255, 255, 255);
  doc.circle(cx - bw * 0.28, cy + s * 0.1, s * 0.18, "F");
  doc.setFillColor(...BRAND_TEAL);
  // Mounting arm going up to bracket
  doc.line(cx + s * 0.1, cy - bh / 2 + s * 0.1, cx + s * 0.1, cy - s * 0.75);
  doc.line(cx - s * 0.3, cy - s * 0.75, cx + s * 0.45, cy - s * 0.75);
}

/** Reception / front desk — desk outline with a person silhouette behind it. */
function iconReception(doc: jsPDF, cx: number, cy: number, s: number): void {
  doc.setDrawColor(...BRAND_TEAL);
  doc.setFillColor(...BRAND_TEAL);
  doc.setLineWidth(0.55);
  // Head circle
  doc.circle(cx, cy - s * 0.6, s * 0.22, "F");
  // Shoulders arc (body)
  arcSegments(doc, cx, cy - s * 0.6, s * 0.42, 20, 160, 14);
  // Desk — horizontal bar below person
  const dw = s * 1.2, dh = s * 0.22;
  doc.rect(cx - dw / 2, cy + s * 0.1, dw, dh, "F");
  // Desk front panel
  doc.rect(cx - dw / 2, cy + dh + s * 0.1, dw, s * 0.18, "S");
}

/** All 8 amenity definitions — key → display label + draw function. */
const AMENITY_CATALOG: Record<string, { label: string; fn: (doc: jsPDF, cx: number, cy: number, s: number) => void }> = {
  wifi:         { label: "Hi-speed Internet",          fn: iconWifi },
  coffee:       { label: "Pantry Services",            fn: iconCoffee },
  printer:      { label: "Printing Facilities",        fn: iconPrinter },
  meeting:      { label: "Conference & Meeting Rooms", fn: iconMeeting },
  power_backup: { label: "Power Backup",               fn: iconPowerBackup },
  parking:      { label: "Parking Available",          fn: iconParking },
  cctv:         { label: "CCTV & Security",            fn: iconCCTV },
  reception:    { label: "Reception / Front Desk",     fn: iconReception },
};

const DEFAULT_AMENITY_ICONS = ["wifi", "coffee", "printer", "meeting"];

/**
 * Renders the "Featured Amenities" icon strip.
 * Only the icons whose keys appear in `iconKeys` are shown.
 * Returns the new Y cursor after the section.
 */
function addServicesIncludedSection(doc: jsPDF, startY: number, iconKeys: string[] = DEFAULT_AMENITY_ICONS): number {
  const active = iconKeys.filter((k) => k in AMENITY_CATALOG);
  if (active.length === 0) return startY;

  const pageWidth = doc.internal.pageSize.getWidth();
  const sectionH = 28;

  doc.setFillColor(240, 250, 245);
  doc.rect(14, startY, pageWidth - 28, sectionH, "F");

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("FEATURED AMENITIES", 16, startY + 5);

  const cols = Math.min(active.length, 4);
  const cellW = (pageWidth - 28) / cols;
  const s = 4.5;
  const iconY = startY + 15;
  const textY = startY + 23.5;

  active.slice(0, 4).forEach((key, i) => {
    const entry = AMENITY_CATALOG[key];
    const cx = 14 + cellW * i + cellW / 2;
    entry.fn(doc, cx, iconY, s);

    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BRAND_TEAL);
    doc.text(entry.label, cx, textY, { align: "center" });
  });

  return startY + sectionH + 4;
}

// ─────────────────────────────────────────────────────────────────────────────

function addLogoToDoc(doc: jsPDF): number {
  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Teal accent bar at the very top ──
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 3, "F");

  // ── Logo image (left side) ──
  // Original logo aspect ratio is ~4:1 (1024x260)
  const logoW = 52;
  const logoH = 13;
  doc.addImage(TWV_LOGO_BASE64, "PNG", 14, 8, logoW, logoH, undefined, "FAST");

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
  doc.text(options.title, pageWidth / 2, y, { align: "center" });

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

  // ── Prepared For / Point of Contact ──
  if (options.lead || options.preparedBy) {
    const hasBoth = !!(options.lead && options.preparedBy);
    const col1X = 16;
    const col2X = hasBoth ? (pageWidth / 2 + 4) : 16;

    // Section header band
    doc.setFillColor(240, 250, 245);
    doc.rect(14, y - 4, pageWidth - 28, 6, "F");

    if (options.lead) {
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...BRAND_TEAL);
      doc.text("PREPARED FOR", col1X, y);
    }
    if (options.preparedBy) {
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...BRAND_TEAL);
      doc.text("YOUR POINT OF CONTACT", col2X, y);
    }
    y += 6;

    let leftY = y;
    let rightY = y;

    // Left column: Lead info
    if (options.lead) {
      const leadName = `${options.lead.first_name || ""} ${options.lead.last_name || ""}`.trim();
      if (leadName) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(...BRAND_DARK);
        doc.text(leadName, col1X, leftY);
        doc.setFont("helvetica", "normal");
        leftY += 5;
      }
      doc.setFontSize(9);
      if (options.lead.company) {
        doc.setTextColor(...BRAND_DARK);
        doc.text(options.lead.company, col1X, leftY);
        leftY += 5;
      }
      if (options.lead.email) {
        doc.setTextColor(100, 100, 100);
        doc.text(options.lead.email, col1X, leftY);
        leftY += 5;
      }
      if (options.lead.phone || options.lead.mobile) {
        doc.setTextColor(100, 100, 100);
        doc.text(options.lead.phone || options.lead.mobile || "", col1X, leftY);
        leftY += 5;
      }
      if (options.location?.name) {
        doc.setTextColor(...BRAND_TEAL);
        doc.setFont("helvetica", "bold");
        doc.text(`Location: ${options.location.name}`, col1X, leftY);
        doc.setFont("helvetica", "normal");
        leftY += 5;
      }
    }

    // Right column: Rep / point of contact info
    if (options.preparedBy) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...BRAND_DARK);
      doc.text(options.preparedBy.name, col2X, rightY);
      doc.setFont("helvetica", "normal");
      rightY += 5;
      doc.setFontSize(9);
      if (options.preparedBy.email) {
        doc.setTextColor(100, 100, 100);
        doc.text(options.preparedBy.email, col2X, rightY);
        rightY += 5;
      }
      if (options.preparedBy.phone) {
        doc.setTextColor(100, 100, 100);
        doc.text(options.preparedBy.phone, col2X, rightY);
        rightY += 5;
      }
    }

    y = Math.max(leftY, rightY) + 4;
  }

  // ── Services Included Strip (proposals only) ──
  if (options.showServicesIncluded) {
    y = addServicesIncludedSection(doc, y, options.amenityIcons);
  }

  // ── Line Items Table ──
  const tableRows = options.items.map((item, i) => {
    const billedQuantity = (item as LineItem & { billed_quantity?: number | null }).billed_quantity;
    return [
      String(i + 1),
      item.description,
      displayQty(item.quantity, billedQuantity),
      item.unit || "",
      formatCurrencyPDF(item.unit_price),
      formatCurrencyPDF(item.total),
    ];
  });

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
      3: { cellWidth: 22, halign: "center" },
      4: { cellWidth: 36, halign: "right" },
      5: { cellWidth: 36, halign: "right" },
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

  // ── Description / Complimentary Services ──
  if (options.description) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text(options.descriptionLabel || "Description", 14, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
    const descLines = doc.splitTextToSize(options.description, pageWidth - 28);
    doc.text(descLines, 14, y);
    y += descLines.length * 4.5 + 6;
  }

  // ── Service Quotas table (proposals) ──
  if (options.serviceQuotas && options.serviceQuotas.length > 0) {
    if (y + 20 > doc.internal.pageSize.getHeight() - 20) { doc.addPage(); y = 20; }
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Service Quotas", 14, y);
    y += 6;

    const quotaRows = options.serviceQuotas.map(q => [
      q.name,
      q.unit_label,
      q.monthly_quota > 0 ? String(q.monthly_quota) : "—",
      q.overage_rate > 0 ? `${formatCurrencyPDF(q.overage_rate)} / ${q.unit_label}` : "No charge",
    ]);

    autoTable(doc, {
      startY: y,
      head: [["Service", "Unit", "Free quota / month", "Addl Usage rate"]],
      body: quotaRows,
      theme: "striped",
      headStyles: { fillColor: BRAND_TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
      alternateRowStyles: { fillColor: [240, 250, 245] },
      bodyStyles: { fontSize: 8, textColor: BRAND_DARK },
      columnStyles: {
        0: { cellWidth: "auto" },
        1: { cellWidth: 28 },
        2: { cellWidth: 38, halign: "center" },
        3: { cellWidth: 48, halign: "right" },
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

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
      sanitizeForPdf(options.termsAndConditions),
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
  // Layout bank details on the left, QR code on the right
  const bankStartY = y;
  bankLines.forEach((line) => {
    doc.text(line, 14, y);
    y += 4.5;
  });

  // ── Razorpay Payment Link — button + raw URL ──────────────────────────────
  if (options.razorpayPaymentLink) {
    y += 5;

    // Section label in small grey caps
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(100, 100, 100);
    doc.text("ONLINE PAYMENT", 14, y);
    y += 5;

    // Filled teal button — shows amount so customer knows exactly what they're paying
    const btnX = 14;
    const btnW = 92;
    const btnH = 10;
    doc.setFillColor(...BRAND_TEAL);
    doc.roundedRect(btnX, y, btnW, btnH, 2, 2, "F");
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(
      `Pay ${formatCurrencyPDF(options.totalAmount)} Online`,
      btnX + btnW / 2,
      y + 7,        // baseline ~70% down the 10mm button
      { align: "center" }
    );
    // Make the entire button rectangle a clickable hyperlink
    doc.link(btnX, y, btnW, btnH, { url: options.razorpayPaymentLink });
    y += btnH + 3;

    // Raw URL below button — visible for copy-paste or print
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 80, 200);
    doc.textWithLink(
      options.razorpayPaymentLink,
      14,
      y,
      { url: options.razorpayPaymentLink }
    );
    y += 7;
  }

  // ── UPI QR Code (right side, next to bank details) ──
  if (options.qrCodeBase64) {
    // Detect original image dimensions to preserve aspect ratio
    let imgW = 38;
    let imgH = 38;
    try {
      const imgProps = doc.getImageProperties(options.qrCodeBase64);
      const origW = imgProps.width;
      const origH = imgProps.height;
      const maxDim = 38; // max width or height in mm
      const scale = Math.min(maxDim / origW, maxDim / origH);
      imgW = origW * scale;
      imgH = origH * scale;
    } catch {
      // Fallback to square if dimensions can't be read
    }

    const qrX = pageWidth - 14 - imgW; // right-aligned with margin
    const qrY = bankStartY - 4;

    // Light border around QR
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.3);
    doc.rect(qrX - 1, qrY - 1, imgW + 2, imgH + 2);

    try {
      doc.addImage(options.qrCodeBase64, "PNG", qrX, qrY, imgW, imgH, undefined, "FAST");
    } catch {
      // Fallback: try as JPEG if PNG fails
      try {
        doc.addImage(options.qrCodeBase64, "JPEG", qrX, qrY, imgW, imgH, undefined, "FAST");
      } catch {
        // Silently skip if image is invalid
      }
    }

    // "Scan to Pay" label below QR
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Scan to Pay", qrX + imgW / 2, qrY + imgH + 4, { align: "center" });

    // UPI ID below label
    if (options.upiId) {
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(`UPI: ${options.upiId}`, qrX + imgW / 2, qrY + imgH + 8, { align: "center" });
    }

    // Ensure y is below QR if QR extends past bank details
    const qrBottomY = qrY + imgH + (options.upiId ? 12 : 8);
    if (qrBottomY > y) y = qrBottomY;
  }
  y += 6;

  // ── Notes ──
  if (options.notes) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_TEAL);
    doc.text(options.notesLabel || "Notes", 14, y);
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
  proposal: Proposal & { location?: Partial<Location> },
  lead?: Partial<Lead>,
  paymentOptions?: { qrCodeBase64?: string; upiId?: string; razorpayPaymentLink?: string },
  preparedBy?: { name: string; email?: string; phone?: string },
  serviceQuotas?: { name: string; unit_label: string; monthly_quota: number; overage_rate: number }[]
): jsPDF {
  // Merge complimentary facilities (e.g. conference room) from proposal into the quotas table
  const facilityRows = ((proposal.complimentary_items ?? []) as { name: string; unit: string; quantity: number; price_per_unit?: number }[])
    .filter(item => item.quantity > 0)
    .map(item => ({
      name: item.name,
      unit_label: item.unit,
      monthly_quota: item.quantity,
      overage_rate: item.price_per_unit ?? 0,
    }));
  const allQuotas = [...(serviceQuotas ?? []), ...facilityRows];

  return generatePDF({
    title: "PROPOSAL",
    documentNumber: proposal.proposal_number,
    items: proposal.items,
    subtotal: proposal.subtotal,
    taxPercentage: proposal.tax_percentage,
    taxAmount: proposal.tax_amount,
    discountPercentage: proposal.discount_percentage,
    discountAmount: proposal.discount_amount,
    totalAmount: proposal.total_amount,
    lead,
    location: proposal.location,
    createdAt: proposal.created_at,
    validUntil: proposal.valid_until,
    description: proposal.description
      ? `${proposal.title}\n${proposal.description}`
      : undefined,
    descriptionLabel: "Complimentary Services Offered",
    termsAndConditions: proposal.terms_and_conditions,
    notes: proposal.notes,
    notesLabel: "Customer Notes",
    qrCodeBase64: paymentOptions?.qrCodeBase64,
    upiId: paymentOptions?.upiId,
    razorpayPaymentLink: paymentOptions?.razorpayPaymentLink,
    preparedBy,
    showServicesIncluded: true,
    amenityIcons: proposal.location?.proposal_amenity_icons ?? undefined,
    serviceQuotas: allQuotas.length > 0 ? allQuotas : undefined,
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
    // Include payment link when available so the downloaded PDF is self-contained
    razorpayPaymentLink: invoice.razorpay_link_url || undefined,
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
  usageCharges?: { description: string; quantity: number; billed_quantity?: number | null; unit_price: number; total: number; charge_date: string }[]
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
      displayQty(c.quantity, c.billed_quantity),
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
  location?: Partial<Location>,
  options?: { applyCompanyStamp?: boolean; stampRef?: string; watermarkDraft?: boolean }
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

  const monthlyFee = contract.subtotal || contract.total_amount || 0;
  const securityDepositMonths = contract.security_deposit_months ?? 3;
  const ifrsd = monthlyFee * securityDepositMonths;
  const escalation = contract.escalation_percentage || 10;
  const noticePeriod = contract.notice_period_months || 2;
  // Fallback for contracts predating the lock_in_months column (migration 00222):
  // lock-in was previously implied as tenure minus notice period.
  const lockInMonths = contract.lock_in_months ?? Math.max(0, contract.tenure_months - noticePeriod);
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

  // White background behind logo so it prints clearly on the teal header
  doc.setFillColor(255, 255, 255);
  doc.rect(marginLeft - 2, 3, 54, 18, "F");
  doc.addImage(TWV_LOGO_BASE64, "PNG", marginLeft, 5, 50, 12.5, undefined, "FAST");

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

  const signatoryIdLabel = contract.member_signatory_id_type === 'aadhaar' ? 'Aadhaar' : 'PAN';
  const entityType = lead?.entity_type || "";
  const isIndividual = entityType === "individual";
  const isSoleProprietorship = entityType === "proprietorship";

  let memberPartyText: string;
  if (isIndividual) {
    memberPartyText = `${memberName}, an individual having their address at ${memberAddress} (PAN: ${panNumber}), hereinafter referred to as "Member" (which expression shall, unless repugnant to the context or meaning thereof, mean and include their heirs, executors, and assigns).`;
  } else if (isSoleProprietorship) {
    const signatoryClause = contract.member_signatory_name
      ? `, represented herein by ${contract.member_signatory_name}, ${contract.member_signatory_designation || "Proprietor"}${contract.member_signatory_pan ? ` (${signatoryIdLabel}: ${contract.member_signatory_pan})` : ""}, duly authorised to execute this Agreement`
      : "";
    memberPartyText = `${memberName}, a sole proprietorship having its principal place of business at ${memberAddress} (PAN: ${panNumber})${signatoryClause}, hereinafter referred to as "Member" (which expression shall, unless repugnant to the context or meaning thereof, mean and include its successors and assigns).`;
  } else {
    const signatoryClause = contract.member_signatory_name
      ? `, represented herein by ${contract.member_signatory_name}, ${contract.member_signatory_designation || "Authorised Signatory"}${contract.member_signatory_pan ? ` (${signatoryIdLabel}: ${contract.member_signatory_pan})` : ""}, duly authorised to execute this Agreement`
      : "";
    memberPartyText = `${memberName}, a company having its registered office at ${memberAddress} (PAN: ${panNumber})${signatoryClause}, hereinafter referred to as "Member" (which expression shall, unless repugnant to the context or meaning thereof, mean and include its successors and assigns).`;
  }
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
    ["4", "Inclusions",
      "\u2022 Electricity & air conditioning consumed during office hours.\n" +
      "\u2022 Wi-Fi and Internet as per fair usage Policy\n" +
      "\u2022 Housekeeping, security and maintenance services\n" +
      "\u2022 Hot tea & coffee from specified vending machine 12 cups per week, per seat."],
    ["5", "Complimentary Services\n(subject to availability)", (contract.complimentary_services || "TBD") +
      "\n\nThese Complimentary Services will not be rolled over from month to month. If these allocated Complimentary Services are exceeded, Member will be responsible for paying fees for such overages as per applicable rates at that time."],
    ["6", "Additional Paid Services",
      "\u2022 Conference Room beyond Complimentary Services (if any)\n" +
      "\u2022 Printouts beyond Complimentary Services\n" +
      "\u2022 Other Food & Beverages sales counters including Cafe / Vending Machine and others.\n" +
      "\u2022 Other value-added member services as available.\n" +
      "\u2022 Additional charges of Rs.2500/- per hour will be implemented after office hours and on Public Holidays."],
    ["7", "Rack Rate of select paid services\n(subject to availability and revision\nwithout prior intimation by management)",
      "\u2022 Conference Room @ INR 1000 per hour plus GST\n" +
      "\u2022 Additional printouts - A4 - Color Rs.20 per sheet / B&W Rs. 5 per sheet. A3 - Color Rs.25 per sheet.\n" +
      "\u2022 Coffee/Tea twice a day compliment, additional cups @ Rs.20/-\n" +
      "\u2022 Additional Car & Bike parking slots - subject to availability."],
    ["8", "Monthly Membership Fees (MMF)", (() => {
      const phases = contract.rate_phases ?? [];
      if (phases.length === 0) {
        return `${formatCurrencyPDF(monthlyFee)} + GST per month\n(${amountInWords(monthlyFee)})`;
      }
      const anchor = contract.phase_start_date || contract.start_date;
      const boundaries = computePhaseBoundaries(anchor, phases);
      // No trailing "after the last phase..." line: what happens once the
      // phase schedule ends is already governed by the Term, Auto-renewal,
      // and Escalation clauses below — restating it here as "flat" previously
      // contradicted the Escalation clause's stated renewal rate.
      return boundaries.map((b) => `${formatDateRange(b.start, b.end)}: ${formatCurrencyPDF(b.rate)} + GST per month`).join("\n");
    })()],
    ["9", "Commencement Date", formatDatePDF(contract.start_date)],
    ["10", "Term", `${contract.tenure_months} months from the Commencement Date`],
    ["11", "Lock-in Period",
      `The Member & the Company shall not be entitled to terminate this Agreement or reduce the number of Work Space during the Lock-in Period of ${lockInMonths}.0 Months commencing from the Commencement Date. After expiry of the Lock-in Period, either party may terminate this Agreement by delivering a Notice for Termination (defined below) of at least ${noticePeriod} month(s).\n\n` +
      `Member shall be liable to pay the Monthly Membership Fees for the unexpired Lock-in Period along with the period for Notice for Termination, if in case this Agreement is terminated by the Member prior to the expiry of the Lock-in Period.`],
    ["12", "Centre Timings",
      "9 A.M. to 9 P.M from Monday to Saturday except public/national holidays.\n" +
      "Support staff available between 9am to 6pm Monday to Saturday, except public/national holidays."],
    ["13", "Interest Free Refundable\nSecurity Deposit (IFRSD)",
      `${securityDepositMonths}.0 times of Monthly Membership Fees.\n\n` +
      `Member will not be allowed to the use of the Work Spaces unless IFRSD has been fully paid.\n\n` +
      `The Company will return the IFRSD or any balance thereof within 30 days from effective date of termination after deduction of dues/outstanding including but not limited to the damage to the Premises/Work Spaces and other costs due to the Company. However, Member shall not be entitled to adjust or seek adjustment of such dues to the Company from the IFRSD during or post termination of the Membership Agreement.`],
    ["14", "Payment Due Upon Signing",
      "\u2022 Interest Free Refundable Security Deposit\n" +
      "\u2022 1st month's pro-rata Monthly Membership Fees\n" +
      "\u2022 GST Registration fee of Rs. 20,000 plus GST"],
    ["15", "Move In Formalities",
      "\u2022 Signing of Membership Agreement\n" +
      "\u2022 KYC of Member and its Employees/Agents/Representatives using the Work Space."],
    ["16", "Monthly Membership Fees,\nDelay and Default in Payment",
      `5th of every month. For payment beyond 7th of the month, INR 100 + taxes will be charged per day per seat. If Member fails to pay the Monthly Membership Fees beyond 20th (twenty) of the month, Company will have the option to terminate membership without any further grace period and adjust the IFRSD against outstanding liability. Upon such termination, the Member shall lose all the complimentary services and shall be liable to vacate the Premises immediately and shall not be allowed to enter the Premises. Any outstanding amount shall be first adjusted on receipt of funds from the Member. We may, in our sole discretion, withhold Services or terminate this Agreement, if any payments remain outstanding even after adjustment.`],
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
    ["17", "Changes/Modifications\nbefore move-in date\n(to be charged on actuals)", "The layout, highlighting the changes/Modification is annexed as Annexure-A to this Agreement (If applicable)."],
    ["18", "Auto-renewal", `In case Notice for Termination (as defined below) is not served before the expiry of the Initial Term, the Membership Agreement will be auto-renewed for another Term, having the same Lock-in Period with escalation on Monthly Membership Fees & all other charges at ${escalation}.0 %.`],
    ["19", "Escalation on monthly\nMembership Fees", `${escalation} % on Monthly Membership Fees and all products and services after expiry of ${contract.tenure_months}.0 months commencing from the Commencement Date.`],
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
  // Rendered as table to match reference document format
  // ================================================================

  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  checkPageBreak(15);
  doc.text("TERMS AND CONDITIONS", pageWidth / 2, y, { align: "center" });
  y += 8;

  const clauses: [string, string, string][] = [
    ["20", "Representation &\nwarranties",
      "Member represents and warrants to the other Party that:\n" +
      "\u2022 It is duly organized and validly existing and in good standing under the laws of the jurisdiction of its organization;\n" +
      "\u2022 Authorized Signatories have complete legal authority and power to execute and perform under this Agreement and has full corporate power and is duly authorized to enter into, execute and deliver this Agreement, and to carry out and otherwise perform its obligations thereunder;\n" +
      "\u2022 This Agreement is a legal, valid and binding obligation and is enforceable against it."],

    ["21", "Force Majeure",
      "In the event of force majeure or default by landlord, which prevents the Member from use and/or access of the Premises, the Membership Fees for such period shall stand abated in the manner prescribed by the Company and in proportion to the reduced liability (if any) of the Company with respect to the Premises including (without restriction) maintenance etc. The Member shall not be entitled to terminate the Agreement during Force Majeure period and/or make any claim on the Company."],

    ["22", "Indemnification",
      "Member hereby indemnifies the Company from and against any and all claims, including third party claims, liabilities, and expenses including reasonable attorneys' fees, resulting from any breach or alleged breach of this Agreement by the Member or its employee, agent guests, invitees or their actions or omissions, except to the extent a claim results from the gross negligence, willful misconduct or fraud of the Company. Member is also responsible and make good the loss resulting in the damage to the Premises/Work Spaces caused by it or their guests, employees etc. Member shall not make any settlement that requires a materially adverse act or admission by the Company or imposes any obligation upon any of the Company Parties unless Member has first obtained our or the relevant Company Party's written consent. None of the Company Parties shall be liable for any obligations arising out of a settlement made without its prior written consent."],

    ["23", "Termination by the\nMember",
      `Member may terminate this Agreement by delivering to the Company, a written notice of at least ${noticePeriod} month(s) ("Notice for Termination") after expiry of the Lock-in Period.`],

    ["24", "Termination or\nsuspension by the\nCompany",
      "Company may terminate this Agreement by delivering to the Member, Notice for Termination after expiry of the Lock-in Period to terminate this Agreement. Notwithstanding the Lock-in Period, Company may withhold Services or immediately terminate this Agreement:\n" +
      "\u2022 Upon default in monthly payment beyond 20th (Twenty) of English calendar month.\n" +
      "\u2022 Upon breach of this Agreement;\n" +
      "\u2022 loss of our rights in the Premises;\n" +
      "\u2022 If any outstanding fees are still due after we provide notice;\n" +
      "\u2022 If Member or any one claiming under it, fails to comply with the terms and conditions of Membership and House Rules, or any other policies or instructions provided by Company or applicable to Member; or"],

    ["25", "Removal from\nProperty upon\nTermination",
      "Prior to the termination or expiration of this Agreement, Member shall remove all its property from the Work Space and Premises. After providing with reasonable notice, Company will be entitled to dispose of any property remaining in or on the Work Space or Premises after the termination or expiration of this Agreement and will not have any obligation to store such property, and Member waives any claims or demands regarding such property or our handling of such property. Member shall be responsible for paying any fees reasonably incurred by Company regarding such removal. Following the termination or expiration of this Agreement, Company will not forward or hold mail or other packages delivered at the Premises."],

    ["26", "Confidentiality",
      "Each of the Parties agree to treat the negotiation and execution of this Agreement, the transactions contemplated herein and any information given to it by the other Party (which is not, on the date it is so given, already in the public domain) for the purpose of the negotiation or execution of this Agreement (\"Confidential Information\") as confidential. Each of the Parties agree that they shall not disclose any Confidential Information to any person except its employees, agents, shareholders and advisors on a strictly need-to-know basis."],

    ["27", "Governing Law and\nDispute Resolution",
      "Governed by Indian law. Disputes shall be resolved by arbitration in accordance with the Arbitration and Conciliation Act 1996 at Chennai only."],

    ["28", "Company Details",
      "SREE DESIGN INFRASTRUCTURE PRIVATE LIMITED\n" +
      "CIN No: U45400TN1987PTC014408\n" +
      "PAN No: AAACU4245J\n" +
      "Goods and Service Tax No: 33AAACU4245J1ZF"],

    ["29", "Bank Account Details",
      `Account Name: ${COMPANY_BANK_DETAILS.accountName}\n` +
      `Bank Name: ${COMPANY_BANK_DETAILS.bank}\n` +
      `Current Account No: ${COMPANY_BANK_DETAILS.accountNumber}\n` +
      `IFSC: ${COMPANY_BANK_DETAILS.ifscCode}\n` +
      `Branch Address: ${COMPANY_BANK_DETAILS.branch}`],

    ["30", "Use of Member\nCompany Name/Logo",
      "Member consent to our non-exclusive, non-transferable use of Member's Company name and/or logo in connection with identifying Member as a member of the Company, alongside those of other Member Companies, on a public-facing \"Membership\". Member warrants that the logo do not infringe upon the rights of any third party and that Member has full authority to provide this consent. Member may terminate this consent at any time upon thirty (30) days' prior notice."],

    ["31", "Severability",
      "Each provision of this Agreement shall be considered separable. To the extent that any provision of this Agreement is prohibited, this Agreement shall be considered amended to the smallest degree possible in order to make the Agreement effective under applicable law."],

    ["32", "Waiver of Claims",
      "To the extent permitted by law, Member on its own behalf and on behalf of its employees, agents, guests and invitees, waive any and all claims and rights against Company and our landlords at the Premises and Company's affiliates, parents, and successors and employees, assignees, officers, agents and directors (collectively, the \"Company Parties\") resulting from injury or damage to, or destruction, theft, or loss of, any property, person, except to the extent caused by the gross negligence, willful misconduct or fraud of the Company Parties."],

    ["33", "Limitation of\nLiability",
      "To the extent permitted by law, the aggregate monetary liability of any of the Company Parties to Member and its employees, agents, guests or invitees for any reason and for all causes of action, will not exceed the total Membership Fees paid by Member to the Company under this Agreement in the last 2 (Two) months prior to the claim arising. None of the Company Parties will be liable under any cause of action, for any indirect, special, incidental, consequential, reliance or punitive damages, including loss of profits or business interruption."],

    ["34", "Other Members",
      "Company do not control and are not responsible for the actions of other member companies, members, or any other third parties. If a dispute arises between Member or their invitees or guests, Company shall have no responsibility or obligation to participate, mediate or indemnify any party."],

    ["35", "Anti-Corruption\nLaw",
      "Neither Member nor any of its employee, directors, officers, employees, agents, subcontractors, representatives or anyone acting on behalf of the Member, (i) has, directly or indirectly, offered, paid, given, promised, or authorized the payment of any money, gift or anything of value to: (A) any Government Official or any commercial party, (B) any person while knowing or having reason to know that all or a portion of such money, gift or thing of value will be offered, paid or given, directly or indirectly, to any Government Official or any commercial party, or (C) any employee or representative of the Company for the purpose of (1) influencing an act or decision of the Government Official or commercial party in his or her official capacity, (2) inducing the Government Official or commercial party to do or omit to do any act in violation of the lawful duty of such official, (3) securing an improper advantage or (4) securing the execution of this Agreement, (ii) will authorize or make any payments or gifts or any offers or promises of payments or gifts of any kind, directly or indirectly, in connection with this Agreement, the Services or the Office Space. For purposes this section, \"Government Official\" means any officer, employee or person acting in an official capacity for any government agency or instrumentality, including state-owned or controlled companies, and public international organizations, as well as a political party or official thereof or candidate for political office."],

    ["36", "Other Terms and\nConditions",
      "\u2022 The Member shall not engage any food vendor for food delivery and/or catering services on a continuing or permanent basis in the Premises. If the Member is desirous of availing food delivery and catering services, the Member shall inform the Company and avail such services through the Company only.\n" +
      "\u2022 Member is barred from usage/installation/affixing whether permanent or temporarily any personal electrical/mechanical equipment/machine including but not restricted to television, toaster, printer, projector etc. anywhere in the Premises without seeking prior written approval from the Company.\n" +
      "\u2022 This Agreement constitutes the entire agreement between the Member & the Company as to its subject matter and supersedes all prior and contemporaneous agreements, proposals or representations, written or oral, concerning its subject matter. No modification, amendment or waiver of any provision of this Agreement shall be effective unless in writing."],
  ];

  autoTable(doc, {
    startY: y,
    body: clauses,
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
      1: { cellWidth: 48, fontStyle: "bold" },
      2: { cellWidth: "auto" },
    },
    margin: { left: marginLeft, right: marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 10;

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

  if (options?.applyCompanyStamp) {
    drawCompanyStamp(doc, col1X, y, colWidth, options.stampRef);
  }

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
  // ENCLOSURE: KYC REQUIREMENTS (4-column table matching reference)
  // ================================================================

  checkPageBreak(20);

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Encl:", marginLeft, y);
  y += 8;

  const kycTableData: string[][] = [
    [
      "Aadhaar Card",
      "PAN Card for Company",
      "Partnership Agreement / registration certificate (if Partnership is registered)",
      "LLP Agreement / registration certificate (if LLP is registered)",
    ],
    [
      "PAN Card",
      "Certificate of Incorporation",
      "Authority letter in favour of the person executing the membership agreement",
      "LLP PAN Card",
    ],
    [
      "Cancelled Cheque",
      "Board Resolution in favour of the authorized Signatory executing the membership agreement",
      "Cancelled Cheque",
      "Cancelled Cheque",
    ],
    [
      "",
      "GST Certificate",
      "KYC (PAN Card & Aadhaar Card) of the Partners",
      "KYC (PAN Card & Aadhaar Card) of all the Partners",
    ],
    [
      "",
      "MOA & AOA",
      "GST Certificate",
      "GST Certificate",
    ],
    [
      "",
      "KYC (PAN Card & Aadhaar Card of all the Directors)",
      "",
      "",
    ],
    [
      "",
      "Cancelled Cheque",
      "",
      "",
    ],
    [
      "",
      "GST Certificate",
      "",
      "",
    ],
  ];

  autoTable(doc, {
    startY: y,
    head: [["For Individual", "For Company", "For Partnership", "For LLP"]],
    body: kycTableData,
    theme: "grid",
    headStyles: {
      fillColor: BRAND_TEAL,
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 8.5,
      cellPadding: 3,
      halign: "center",
    },
    bodyStyles: {
      fontSize: 8,
      textColor: [50, 50, 50],
      cellPadding: 3,
      lineColor: [200, 200, 200],
      lineWidth: 0.3,
    },
    alternateRowStyles: {
      fillColor: [245, 250, 248],
    },
    columnStyles: {
      0: { cellWidth: "auto" },
      1: { cellWidth: "auto" },
      2: { cellWidth: "auto" },
      3: { cellWidth: "auto" },
    },
    margin: { left: marginLeft, right: marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

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

  // ================================================================
  // DRAFT watermark — every page, forced on until start_date is locked
  // in (i.e. the proposal's pro-rata invoice is paid and the occupation
  // date is firm). Once locked, it's off by default but callers can
  // still opt back in via options.watermarkDraft (e.g. a manual
  // "include watermark" toggle) — that option has no effect while
  // unconfirmed, it can only ever add the watermark back, never remove
  // the forced one. See supabase/migrations/00503_contract_start_date_confirmation.sql.
  // ================================================================
  const showWatermark = !contract.start_date_confirmed || !!options?.watermarkDraft;
  if (showWatermark) {
    for (let i = 1; i <= totalPageCount; i++) {
      doc.setPage(i);
      const ph = doc.internal.pageSize.getHeight();
      const pw = doc.internal.pageSize.getWidth();

      doc.saveGraphicsState();
      doc.setGState(new GState({ opacity: 0.15 }));
      doc.setFont("helvetica", "bold");
      doc.setFontSize(90);
      doc.setTextColor(200, 30, 30);
      doc.text("DRAFT", pw / 2, ph / 2, { align: "center", angle: 45 });
      doc.restoreGraphicsState();
    }
  }

  return doc;
}

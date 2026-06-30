/**
 * Shared PDF utilities for agreement/proposal generation.
 * Used by agreement-generator.ts (proposals) and leave-license-generator.ts (L&L agreements).
 */
import jsPDF from "jspdf";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";

// TWV Brand Colors
export const BRAND_TEAL: [number, number, number] = [1, 94, 101];
export const BRAND_GREEN: [number, number, number] = [0, 174, 108];
export const BRAND_DARK: [number, number, number] = [26, 27, 30];

export const COMPANY_NAME = "SREE DESIGN INFRASTRUCTURE PRIVATE LIMITED";
export const BRAND_NAME = "The WorkVilla";
export const COMPANY_ADDRESS = [
  "Prakash Presidium, 110, Mahatma Gandhi Road,",
  "Nungambakkam, Chennai - 600034",
];
export const COMPANY_PHONE = "+91 97910 97900";
export const COMPANY_WEBSITE = "www.theworkvilla.com";
export const COMPANY_GST = "GST: 33AAACU4245J1ZF";

// L&L Agreement property address (different from registered office)
export const LL_PROPERTY_ADDRESS =
  "'Kamala Arcade', Old No.669, New No.306, Anna Salai, Thousand Lights, Chennai - 600006";
export const LESSOR_DIRECTOR = "Naval Chordia";

export function formatCurrency(amount: number): string {
  return (
    "Rs. " +
    new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount)
  );
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Add the standard TWV brand header to a page.
 * Returns the Y position after the header.
 */
export function addBrandHeader(doc: jsPDF): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginRight = 15;
  const marginLeft = 15;

  doc.setFillColor(...BRAND_TEAL);
  doc.rect(0, 0, pageWidth, 25, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 25, pageWidth, 1.5, "F");

  doc.addImage(TWV_LOGO_BASE64, "PNG", marginLeft, 5, 50, 12.5);

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(255, 255, 255);
  doc.text(COMPANY_NAME, pageWidth - marginRight, 10, { align: "right" });
  doc.text(COMPANY_ADDRESS.join(" "), pageWidth - marginRight, 14, { align: "right" });
  doc.text(`${COMPANY_PHONE} | ${COMPANY_WEBSITE}`, pageWidth - marginRight, 18, { align: "right" });

  return 38;
}

/**
 * Add the standard TWV footer to a page.
 */
export function addFooter(doc: jsPDF): void {
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();

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
  doc.text(
    `${COMPANY_ADDRESS.join(" ")}  |  ${COMPANY_PHONE}  |  ${COMPANY_WEBSITE}`,
    pw / 2,
    ph - 4,
    { align: "center" }
  );
}

/**
 * Helper context for managing Y position and page breaks in a jsPDF doc.
 */
export function createPdfContext(doc: jsPDF, startY: number) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 15;
  const marginRight = 15;
  const contentWidth = pageWidth - marginLeft - marginRight;
  const maxY = pageHeight - 20;
  let y = startY;

  function checkPageBreak(needed: number): void {
    if (y + needed > maxY) {
      addFooter(doc);
      doc.addPage();
      y = 20;
    }
  }

  function addWrappedText(
    text: string,
    x: number,
    width: number,
    fontSize: number,
    style: string = "normal",
    color: [number, number, number] = [50, 50, 50],
    lineHeight: number = 5
  ): void {
    doc.setFontSize(fontSize);
    doc.setFont("helvetica", style);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, width);
    for (const line of lines) {
      checkPageBreak(lineHeight + 2);
      // Re-apply font/color after checkPageBreak — addFooter resets text color to mint green
      doc.setFontSize(fontSize);
      doc.setFont("helvetica", style);
      doc.setTextColor(...color);
      doc.text(line, x, y);
      y += lineHeight;
    }
  }

  return {
    get y() { return y; },
    set y(val: number) { y = val; },
    pageWidth,
    pageHeight,
    marginLeft,
    marginRight,
    contentWidth,
    maxY,
    checkPageBreak,
    addWrappedText,
  };
}

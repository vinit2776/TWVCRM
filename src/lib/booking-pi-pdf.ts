import jsPDF from "jspdf";
import QRCode from "qrcode";
import { BRAND_DARK, BRAND_TEAL, addBrandHeader, addFooter, formatCurrency, formatDate } from "@/lib/pdf-utils";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { BOOKING_PI_NOTES, type BookingPiTotals } from "@/lib/booking-pi";

export interface BookingPiPdfInput {
  pi_number: string;
  booking_number: string | null;
  customer_name: string;
  company: string | null;
  location_name: string;
  space_name: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  totals: BookingPiTotals;
  paid_so_far: number;
  /** Absent on a preview made before the link exists. */
  payment_link_url: string | null;
}

// jsPDF's built-in Helvetica is Latin-1 only; see deposit-request-pdf.ts.
const clean = (text: string) => text.replace(/₹/g, "Rs.").replace(/[^\x00-\xFF]/g, "");

/**
 * One-page proforma invoice for a booking. Read-only: builds a document and
 * touches nothing else, which is what lets the preview route call it freely.
 */
export async function generateBookingPiPdf(input: BookingPiPdfInput): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const left = 15;
  const right = doc.internal.pageSize.getWidth() - 15;
  let y = addBrandHeader(doc);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Proforma Invoice", left, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(102, 102, 102);
  doc.text("This is not a tax invoice.", right, y, { align: "right" });
  y += 9;

  doc.setFontSize(10);
  doc.setTextColor(...BRAND_DARK);
  const billTo = input.company ? `${input.customer_name}, ${input.company}` : input.customer_name;
  const meta: [string, string][] = [
    ["PI number", input.pi_number],
    ["Booking", input.booking_number ?? "-"],
    ["Billed to", billTo || "Customer"],
    ["Space", `${input.space_name}, ${input.location_name}`],
    ["When", `${formatDate(input.booking_date + "T00:00:00")}, ${input.start_time.slice(0, 5)} - ${input.end_time.slice(0, 5)}`],
  ];
  meta.forEach(([label, value]) => {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(102, 102, 102);
    doc.text(label, left, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BRAND_DARK);
    doc.text(clean(value), left + 32, y);
    y += 6;
  });
  y += 3;

  // Line table: Qty x Rate = Amount, then GST.
  const cols = { desc: left, qty: 105, rate: 128, amt: 155, gst: right };
  doc.setFillColor(...BRAND_TEAL);
  doc.rect(left, y - 4.5, right - left, 7, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("Description", cols.desc + 2, y);
  doc.text("Qty", cols.qty, y, { align: "right" });
  doc.text("Rate", cols.rate, y, { align: "right" });
  doc.text("Amount", cols.amt, y, { align: "right" });
  doc.text("GST", cols.gst - 2, y, { align: "right" });
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(...BRAND_DARK);
  for (const line of input.totals.lines) {
    doc.text(doc.splitTextToSize(clean(line.description), 80)[0], cols.desc + 2, y);
    doc.text(String(line.quantity), cols.qty, y, { align: "right" });
    doc.text(formatCurrency(line.rate), cols.rate, y, { align: "right" });
    doc.text(formatCurrency(line.amount), cols.amt, y, { align: "right" });
    doc.text(`${formatCurrency(line.gst_amount)} (${line.gst_rate}%)`, cols.gst - 2, y, { align: "right" });
    y += 6;
  }
  y += 2;
  doc.setDrawColor(200, 200, 200);
  doc.line(left, y, right, y);
  y += 6;

  const totals: [string, string, boolean][] = [
    ["Subtotal", formatCurrency(input.totals.subtotal), false],
    ["GST", formatCurrency(input.totals.gst), false],
    ["Total", formatCurrency(input.totals.total), true],
  ];
  if (input.paid_so_far > 0) {
    totals.push(["Paid so far", `- ${formatCurrency(input.paid_so_far)}`, false]);
    totals.push(["Balance payable", formatCurrency(Math.max(0, input.totals.total - input.paid_so_far)), true]);
  }
  totals.forEach(([label, value, bold]) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setTextColor(...(bold ? BRAND_TEAL : BRAND_DARK));
    doc.text(label, cols.amt - 25, y);
    doc.text(value, right, y, { align: "right" });
    y += 6;
  });
  y += 4;

  // Terms the customer should see before paying.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Notes", left, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...BRAND_DARK);
  for (const note of BOOKING_PI_NOTES) {
    doc.text(clean(`- ${note}`), left, y);
    y += 5;
  }
  y += 5;

  if (input.payment_link_url) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Pay online", left, y);
    y += 5;
    const qr = await QRCode.toDataURL(input.payment_link_url, { margin: 1, width: 300 });
    doc.addImage(qr, "PNG", left, y, 34, 34);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...BRAND_DARK);
    doc.text("Scan the QR code, or open this secure Razorpay link:", left + 40, y + 10);
    doc.setTextColor(0, 102, 204);
    doc.textWithLink(input.payment_link_url, left + 40, y + 17, { url: input.payment_link_url });
    y += 40;
  } else {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9);
    doc.setTextColor(102, 102, 102);
    doc.text("The secure payment link and QR code appear here once the PI is sent.", left, y);
    y += 10;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_TEAL);
  doc.text("Or pay at the counter when you arrive, or by bank transfer", left, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...BRAND_DARK);
  const bank: [string, string][] = [
    ["Account", COMPANY_BANK_DETAILS.accountName],
    ["A/C No", COMPANY_BANK_DETAILS.accountNumber],
    ["IFSC", COMPANY_BANK_DETAILS.ifscCode],
    ["Bank", `${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}`],
    ["Reference", input.pi_number],
  ];
  bank.forEach(([label, value]) => {
    doc.text(`${label}: ${value}`, left, y);
    y += 5;
  });

  addFooter(doc);
  return doc;
}

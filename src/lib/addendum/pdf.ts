import jsPDF from "jspdf";
import { addBrandHeader, addFooter, createPdfContext, BRAND_DARK } from "@/lib/pdf-utils";

export interface AddendumPdfInput {
  /** "TWV-C-0125/ADD-1" */
  reference: string;
  contractNumber: string;
  text: string;
  /** One block per signature line: two for a rename, three for a takeover. */
  signatories: { role: string; name: string }[];
  draft?: boolean;
}

/** Renders the (edited) wording as a branded PDF with a signature block per party. */
export function buildAddendumPdf(input: AddendumPdfInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const startY = addBrandHeader(doc);
  const ctx = createPdfContext(doc, startY);
  const left = 15;
  const width = doc.internal.pageSize.getWidth() - 30;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(...BRAND_DARK);
  doc.text(input.text.match(/ADDENDUM NO\. \d+/)?.[0] ?? "ADDENDUM", doc.internal.pageSize.getWidth() / 2, ctx.y, { align: "center" });
  ctx.y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text(`${input.reference} · to the Membership Agreement, Contract ${input.contractNumber}`, doc.internal.pageSize.getWidth() / 2, ctx.y, { align: "center" });
  ctx.y += 9;

  for (const raw of input.text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { ctx.y += 2.5; continue; }
    const heading = /^[A-Z][A-Z ]{3,}$/.test(line.trim());
    const approx = Math.ceil((doc.getTextWidth(line) * (heading ? 1.1 : 1)) / width) * 5 + 2;
    ctx.checkPageBreak(approx);
    ctx.addWrappedText(line, left, width, heading ? 10 : 10, heading ? "bold" : "normal", [40, 40, 40], 5);
  }

  ctx.checkPageBreak(55);
  ctx.y += 10;
  const colW = width / input.signatories.length;
  const names = input.signatories.map((s) => s.name);
  const roles = input.signatories.map((s) => s.role);
  const y = ctx.y + 22;
  doc.setDrawColor(60, 60, 60);
  names.forEach((name, i) => {
    const x = left + i * colW;
    doc.line(x, y, x + colW - 8, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...BRAND_DARK);
    doc.text(roles[i], x, y + 5);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    doc.text(doc.splitTextToSize(name || " ", colW - 10), x, y + 9.5);
    doc.text("Date:", x, y + 21);
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    addFooter(doc);
    if (input.draft) {
      doc.setTextColor(210, 210, 210);
      doc.setFontSize(60);
      doc.setFont("helvetica", "bold");
      doc.text("DRAFT", doc.internal.pageSize.getWidth() / 2, 150, { align: "center", angle: 35 });
    }
  }
  return Buffer.from(doc.output("arraybuffer"));
}

import jsPDF from "jspdf";
import { addBrandHeader, addFooter, createPdfContext, BRAND_DARK, BRAND_TEAL } from "@/lib/pdf-utils";
import { sanitizeForPdf } from "@/lib/pdf-text";

export interface AddendumPdfInput {
  /** "TWV-C-0125/ADD-1" */
  reference: string;
  contractNumber: string;
  text: string;
  /** One block per signature line: two for a rename, three for a takeover. */
  signatories: { role: string; name: string }[];
  /** Names printed in bold wherever they appear in the wording (the parties). */
  boldTerms?: string[];
  draft?: boolean;
}

type Word = { text: string; bold: boolean };

/** Splits a paragraph into words, marking the ones that belong to a bold term. */
function toWords(line: string, terms: string[]): Word[] {
  const found = terms.map((t) => t.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const marks = new Array<boolean>(line.length).fill(false);
  for (const t of found) {
    let i = line.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) marks[k] = true;
      i = line.indexOf(t, i + t.length);
    }
  }
  const words: Word[] = [];
  let start = 0;
  for (let i = 0; i <= line.length; i++) {
    if (i === line.length || line[i] === " ") {
      if (i > start) words.push({ text: line.slice(start, i), bold: marks.slice(start, i).some(Boolean) });
      start = i + 1;
    }
  }
  return words;
}

/**
 * Renders the (edited) wording as a branded PDF laid out like the Membership Agreement: teal title with an
 * underline, Ref line, teal bold section headings, 9 pt body with the same line height, and a signature block
 * per party. Party names are bold.
 */
export function buildAddendumPdf(input: AddendumPdfInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const startY = addBrandHeader(doc);
  const ctx = createPdfContext(doc, startY);
  const { marginLeft, marginRight, contentWidth, pageWidth } = ctx;
  const BODY: [number, number, number] = [50, 50, 50];
  const terms = input.boldTerms ?? [];

  ctx.y = Math.max(ctx.y, 38);
  const title = input.text.match(/ADDENDUM NO\. \d+/)?.[0] ?? "ADDENDUM";
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...BRAND_TEAL);
  doc.text(title, pageWidth / 2, ctx.y, { align: "center" });
  ctx.y += 3;
  const titleWidth = doc.getTextWidth(title);
  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(0.5);
  doc.line((pageWidth - titleWidth) / 2, ctx.y, (pageWidth + titleWidth) / 2, ctx.y);
  ctx.y += 8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  doc.text(`Ref: ${input.reference}`, marginLeft, ctx.y);
  doc.text(`To the Membership Agreement, Contract ${input.contractNumber}`, pageWidth - marginRight, ctx.y, { align: "right" });
  ctx.y += 10;

  /** Wrapped paragraph with bold party names; left aligned like the agreement. */
  const rich = (line: string, x: number, width: number) => {
    const words = toWords(line, terms);
    const lineHeight = 4.5;
    let row: Word[] = [];
    let rowWidth = 0;
    const space = () => { doc.setFont("helvetica", "normal"); doc.setFontSize(9); return doc.getTextWidth(" "); };
    const measure = (w: Word) => { doc.setFont("helvetica", w.bold ? "bold" : "normal"); doc.setFontSize(9); return doc.getTextWidth(w.text); };
    const flush = () => {
      ctx.checkPageBreak(lineHeight + 2);
      // Draw each run of same-weight words in one piece so the font spaces the words itself.
      const runs: Word[] = [];
      for (const w of row) {
        const last = runs[runs.length - 1];
        if (last && last.bold === w.bold) last.text += ` ${w.text}`;
        else runs.push({ ...w });
      }
      let cx = x;
      runs.forEach((r, i) => {
        doc.setFont("helvetica", r.bold ? "bold" : "normal");
        doc.setFontSize(9);
        doc.setTextColor(...BODY);
        doc.text(r.text, cx, ctx.y);
        // The fonts are not embedded, so a viewer's own Helvetica can differ a hair from the metrics: pad where weight changes.
        cx += doc.getTextWidth(r.text) + (i < runs.length - 1 ? space() + 0.8 : 0);
      });
      ctx.y += lineHeight;
      row = [];
      rowWidth = 0;
    };
    for (const w of words) {
      const wl = measure(w);
      const add = row.length ? space() + wl : wl;
      if (row.length && rowWidth + add > width) flush();
      rowWidth += row.length ? space() + wl : wl;
      row.push(w);
    }
    if (row.length) flush();
  };

  for (const raw of sanitizeForPdf(input.text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[A-Z][A-Z ]{3,}$/.test(line)) {
      ctx.checkPageBreak(14);
      ctx.y += 4;
      ctx.addWrappedText(line, marginLeft, contentWidth, 10, "bold", BRAND_TEAL, 5);
      ctx.y += 2;
    } else if (/^\d+\./.test(line) || /^[A-Z]\./.test(line)) {
      rich(line, marginLeft + 4, contentWidth - 4);
      ctx.y += 1;
    } else {
      rich(line, marginLeft, contentWidth);
      ctx.y += 1.5;
    }
  }

  ctx.checkPageBreak(55);
  ctx.y += 10;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_DARK);
  doc.text("IN WITNESS WHEREOF, the parties have executed this Addendum.", marginLeft, ctx.y);
  ctx.y += 15;

  const gap = 12;
  const colW = (contentWidth - gap * (input.signatories.length - 1)) / input.signatories.length;
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.3);
  const y = ctx.y + 14;
  input.signatories.forEach((s, i) => {
    const x = marginLeft + i * (colW + gap);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...BRAND_TEAL);
    doc.text(s.role, x, ctx.y);
    doc.line(x, y, x + colW, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    doc.text(doc.splitTextToSize(sanitizeForPdf(s.name) || " ", colW), x, y + 5);
    doc.text("Date:", x, y + 17);
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    addFooter(doc);
    if (input.draft) {
      doc.setTextColor(210, 210, 210);
      doc.setFontSize(60);
      doc.setFont("helvetica", "bold");
      doc.text("DRAFT", pageWidth / 2, 150, { align: "center", angle: 35 });
    }
  }
  return Buffer.from(doc.output("arraybuffer"));
}

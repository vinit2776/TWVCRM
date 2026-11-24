import jsPDF from "jspdf";
import { TWV_LOGO_BASE64 } from "@/lib/logo-data";
import { sanitizeForPdf } from "@/lib/pdf-text";
import type { NocLetter } from "@/lib/noc/rules";

export interface NocPdfInput {
  letter: NocLetter;
  /** "TWV-C-0125/NOC-1" */
  reference: string;
  /** "NOC-0007" */
  nocNumber: string;
  companyName: string;
  /** Part 1 only ever renders drafts. The clean certificate is produced by the issue step, after full payment. */
  draft: true;
  /** Words printed in bold wherever they appear (the filled-in fields), as in the approved format. */
  boldTerms: string[];
}

const MARGIN = 20;
const BODY_SIZE = 10;
const LINE = 4.6;
// The built-in fonts are not embedded, so a viewer may draw bold slightly wider than jsPDF measures it. Reserve a
// little extra room after bold text so the next word never touches it.
const BOLD_WIDEN = 1.04;

/** Splits a paragraph into words, marking the ones that belong to a bold term. */
function toWords(line: string, terms: string[]): { text: string; bold: boolean }[] {
  const found = terms.map((t) => t.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const marks = new Array<boolean>(line.length).fill(false);
  for (const t of found) {
    let i = line.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) marks[k] = true;
      i = line.indexOf(t, i + t.length);
    }
  }
  const words: { text: string; bold: boolean }[] = [];
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
 * The NOC as a PDF in the approved format: logo and letterhead, the letter, then the signature block. A draft is
 * marked in the content itself (a heading line, the order number, a footer on every page) as well as by the tiled
 * watermark, so removing the diagonal mark still leaves a page that says it is a draft and not valid.
 */
export function buildNocPdf(input: NocPdfInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const width = pageW - MARGIN * 2;
  let y = 12;

  // ── Letterhead ──
  try { doc.addImage(TWV_LOGO_BASE64, "PNG", pageW / 2 - 25, y, 50, 12.5, undefined, "FAST"); } catch { /* logo is decoration */ }
  y += 21;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(19);
  doc.setTextColor(20, 20, 20);
  doc.text("SREE DESIGN INFRASTRUCTURE PVT LTD", pageW / 2, y, { align: "center" });
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(sanitizeForPdf("“Prakash Presidium” 110, Mahatma Gandhi Road, Chennai – 600 034"), pageW / 2, y, { align: "center" });
  y += 4.5;
  doc.text("Tel: 91 44 28226001/2, E-mail: email@chordia.asia", pageW / 2, y, { align: "center" });
  y += 4;
  doc.setFontSize(8);
  doc.text("CIN: U45400TN1987PTC014408, GST: 33AAACU4245J1ZF", pageW / 2, y, { align: "center" });
  y += 7;

  // ── Draft banner, in the content ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(185, 28, 28);
  doc.text(sanitizeForPdf(`DRAFT, NOT VALID. Staff copy, never sent to the customer. ${input.nocNumber} · ${input.companyName}`), pageW / 2, y, { align: "center", maxWidth: width });
  y += 8;

  const newPageIfNeeded = (needed: number) => {
    if (y + needed > pageH - 22) { doc.addPage(); y = 20; }
  };

  const plain = (text: string, bold = false, gap = 4) => {
    doc.setFont("times", bold ? "bold" : "normal");
    doc.setFontSize(BODY_SIZE);
    doc.setTextColor(0, 0, 0);
    const lines = doc.splitTextToSize(sanitizeForPdf(text), width) as string[];
    for (const l of lines) { newPageIfNeeded(LINE + 2); doc.text(l, MARGIN, y); y += LINE; }
    y += gap;
  };

  /** A paragraph with the filled-in fields in bold, wrapped word by word, left aligned. */
  const rich = (text: string, gap = 4) => {
    const words = toWords(sanitizeForPdf(text), input.boldTerms.map(sanitizeForPdf));
    const measure = (w: { text: string; bold: boolean }) => { doc.setFont("times", w.bold ? "bold" : "normal"); doc.setFontSize(BODY_SIZE); return doc.getTextWidth(w.text) * (w.bold ? BOLD_WIDEN : 1); };
    const space = () => { doc.setFont("times", "normal"); doc.setFontSize(BODY_SIZE); return doc.getTextWidth(" "); };
    let row: { text: string; bold: boolean }[] = [];
    let rowW = 0;
    const flush = () => {
      newPageIfNeeded(LINE + 2);
      // Draw each run of same-weight words in one piece so the font spaces them itself; pad where weight changes.
      const runs: { text: string; bold: boolean }[] = [];
      for (const w of row) {
        const last = runs[runs.length - 1];
        if (last && last.bold === w.bold) last.text += ` ${w.text}`;
        else runs.push({ ...w });
      }
      let x = MARGIN;
      runs.forEach((r, i) => {
        doc.setFont("times", r.bold ? "bold" : "normal");
        doc.setFontSize(BODY_SIZE);
        doc.setTextColor(0, 0, 0);
        doc.text(r.text, x, y);
        x += doc.getTextWidth(r.text) * (r.bold ? BOLD_WIDEN : 1) + (i < runs.length - 1 ? space() + 0.3 : 0);
      });
      y += LINE; row = []; rowW = 0;
    };
    for (const w of words) {
      const add = row.length ? space() + 0.3 + measure(w) : measure(w);
      if (row.length && rowW + add > width) flush();
      rowW += row.length ? space() + 0.3 + measure(w) : measure(w);
      row.push(w);
    }
    if (row.length) flush();
    y += gap;
  };

  const l = input.letter;
  l.addressee.forEach((a, i) => plain(a, false, i === l.addressee.length - 1 ? 5 : 0));
  plain(l.subject, true, 4);
  plain(l.intro, false, 1);
  rich(l.addressLine, 4);
  rich(l.agreementLine, 4);
  rich(l.consentLine, 4);
  l.clauses.forEach((c) => plain(c, false, 4));
  l.closing.forEach((c, i) => plain(c, false, i === l.closing.length - 1 ? 5 : 3));
  newPageIfNeeded(26);
  doc.setFont("times", "normal");
  doc.setFontSize(BODY_SIZE);
  doc.setTextColor(0, 0, 0);
  for (const s of l.signature) {
    doc.text(s.label, MARGIN, y);
    if (s.label === "Signature:") doc.line(MARGIN + 38, y + 0.5, MARGIN + 80, y + 0.5);
    else doc.text(sanitizeForPdf(s.value), MARGIN + 38, y);
    y += LINE + 0.5;
  }

  // ── Every page: tiled watermark, footer line ──
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    // Translucent, so the letter stays readable underneath it (an opaque mark would blank the words it covers).
    doc.saveGraphicsState();
    // jsPDF's typings do not describe the GState constructor that exists at runtime.
    const GState = (doc as unknown as { GState: new (p: { opacity: number }) => Parameters<typeof doc.setGState>[0] }).GState;
    doc.setGState(new GState({ opacity: 0.13 }));
    doc.setFont("helvetica", "bold");
    doc.setFontSize(50);
    doc.setTextColor(90, 90, 90);
    for (const [cx, cy] of [[60, 80], [150, 135], [60, 195], [150, 250]] as const) {
      doc.text("DRAFT", cx, cy, { align: "center", angle: 32 });
    }
    doc.restoreGraphicsState();
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(150, 150, 150);
    doc.text(sanitizeForPdf(`${input.nocNumber} · ${input.reference} · ${input.companyName} · DRAFT, NOT VALID · page ${p} of ${pages}`), pageW / 2, pageH - 9, { align: "center", maxWidth: width });
  }
  return Buffer.from(doc.output("arraybuffer"));
}

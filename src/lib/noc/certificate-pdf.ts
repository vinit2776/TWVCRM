import jsPDF from "jspdf";
import { addBrandHeader, addFooter, createPdfContext, BRAND_DARK, BRAND_TEAL } from "@/lib/pdf-utils";
import { sanitizeForPdf } from "@/lib/pdf-text";
import { NOC_CLAUSES, NOC_TEXT_VERSION, PURPOSE_LABELS, type NocPurpose } from "@/lib/noc/rules";
import { serviceTerms, type SignatoryMatch } from "@/lib/noc/acceptance";

export interface CertificateInput {
  certificateNo: string;       // "ACC-NOC-0001"
  reference: string;           // "TWV-C-0125/NOC-1"
  nocNumber: string;
  purpose: NocPurpose;
  company: string;
  centre: string;
  contractNumber: string;
  agreementDate: string | null;
  validUntilLabel: string;
  typedName: string;
  typedDesignation: string;
  signatory: { recorded: string | null; match: SignatoryMatch };
  codeSentTo: string;          // masked
  codeSentAt: string | null;   // ISO
  codeEnteredAt: string | null;
  linkSentTo: string | null;   // masked
  linkSentBy: string | null;
  linkSentAt: string | null;
  firstOpenedAt: string | null;
  acceptedAt: string;          // ISO
  ip: string | null;
  device: string | null;
  textHash: string;
  feeTotal: number;
}

const ist = (iso: string | null) =>
  iso ? `${new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} IST` : "not recorded";
const ymdLong = (ymd: string | null) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const utc = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";

const MATCH_TEXT: Record<SignatoryMatch, string> = {
  matches: "name matches the signatory on the agreement",
  partial: "name partly matches the signatory on the agreement",
  mismatch: "name does NOT match the signatory on the agreement (flagged for review)",
  no_record: "no signatory is recorded on the agreement to compare with",
};

/**
 * One-page evidence record of a customer's electronic acceptance, made at the moment they accept and never edited
 * afterwards. It ties the acceptance to a named person (typed name matched to the agreement's signatory, a code
 * delivered to the contact on the contract), to the exact words (a hash of the text shown), and to a time, place and
 * device. The full text accepted follows on page two.
 */
export function buildAcceptanceCertificatePdf(i: CertificateInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, addBrandHeader(doc));
  const L = ctx.marginLeft;
  const W = ctx.contentWidth;
  ctx.y = Math.max(ctx.y, 36);

  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(...BRAND_TEAL);
  doc.text("ACCEPTANCE CERTIFICATE", ctx.pageWidth / 2, ctx.y, { align: "center" });
  const tw = doc.getTextWidth("ACCEPTANCE CERTIFICATE");
  doc.setDrawColor(...BRAND_TEAL); doc.setLineWidth(0.5);
  doc.line((ctx.pageWidth - tw) / 2, ctx.y + 2.5, (ctx.pageWidth + tw) / 2, ctx.y + 2.5);
  ctx.y += 9;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90, 90, 90);
  doc.text(sanitizeForPdf(`Electronic acceptance of the terms of NOC ${i.reference} · Certificate ${i.certificateNo}`), ctx.pageWidth / 2, ctx.y, { align: "center" });
  ctx.y += 9;

  const section = (title: string, rows: [string, string][]) => {
    ctx.checkPageBreak(14 + rows.length * 5.5);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...BRAND_TEAL);
    doc.text(title, L, ctx.y); ctx.y += 5;
    for (const [k, v] of rows) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(90, 90, 90);
      doc.text(sanitizeForPdf(k), L, ctx.y);
      doc.setFont("helvetica", "normal"); doc.setTextColor(...BRAND_DARK);
      const lines = doc.splitTextToSize(sanitizeForPdf(v), W - 52) as string[];
      lines.forEach((ln, idx) => { doc.text(ln, L + 52, ctx.y + idx * 4.2); });
      ctx.y += Math.max(1, lines.length) * 4.2 + 1.3;
    }
    ctx.y += 3;
  };

  section("1. Who accepted", [
    ["Name given", i.typedName], ["Designation given", i.typedDesignation], ["On behalf of", i.company],
    ["Contract", `${i.contractNumber}${i.agreementDate ? `, Membership Agreement dated ${ymdLong(i.agreementDate)}` : ""}`],
    ["For", `NOC · ${PURPOSE_LABELS[i.purpose]} · ${i.centre} · valid till ${i.validUntilLabel}`],
  ]);
  section("2. How the person was linked to the customer", [
    ["Signatory on the agreement", `${i.signatory.recorded ?? "none recorded"}: ${MATCH_TEXT[i.signatory.match]}`],
    ["One-time code sent to", `${i.codeSentTo}, the email recorded on the contract`],
    ["Code sent / entered", `${ist(i.codeSentAt)} / ${ist(i.codeEnteredAt)}`],
    ["Link was sent", i.linkSentAt ? `to ${i.linkSentTo ?? "the customer"} by ${i.linkSentBy ?? "staff"}, ${ist(i.linkSentAt)}` : "shared by hand by staff"],
  ]);
  section("3. What was accepted", [
    ["Items ticked", `${NOC_CLAUSES.length} NOC paragraphs and the service terms (all ${NOC_CLAUSES.length + 1} boxes)`],
    ["Text version", NOC_TEXT_VERSION],
    ["SHA-256 of the exact text", i.textHash],
    ["Fee shown", `Rs. ${i.feeTotal.toLocaleString("en-IN")} including GST`],
  ]);
  section("4. When and from where", [
    ["Accepted", `${ist(i.acceptedAt)} (${utc(i.acceptedAt)}), our server's clock`],
    ["IP address", i.ip ?? "not recorded"], ["Device", i.device ?? "not recorded"], ["Link first opened", ist(i.firstOpenedAt)],
  ]);
  section("5. Record integrity", [
    ["Order", `${i.nocNumber} · ${i.reference}`],
    ["Log", "Each step is kept in an append-only log that no one can edit. This certificate was made when the customer accepted and is not changed afterwards."],
  ]);

  doc.addPage(); ctx.y = 24;
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...BRAND_TEAL);
  doc.text("The text accepted", L, ctx.y); ctx.y += 7;
  const para = (t: string) => ctx.addWrappedText(sanitizeForPdf(t), L, W, 9, "normal", [40, 40, 40], 4.5);
  NOC_CLAUSES.forEach((c, idx) => { para(`${idx + 1}. ${c}`); ctx.y += 2.5; });
  para(`${NOC_CLAUSES.length + 1}. Service terms: ${serviceTerms(i.validUntilLabel)}`);

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) { doc.setPage(p); addFooter(doc); }
  return Buffer.from(doc.output("arraybuffer"));
}

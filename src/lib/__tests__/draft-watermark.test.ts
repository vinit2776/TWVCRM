import { describe, it, expect, vi } from "vitest";
import { applyDraftWatermark, isDraftAgreement } from "@/lib/draft-watermark";
import { PDFDocument } from "pdf-lib";

async function blankPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return doc.save();
}

describe("isDraftAgreement", () => {
  it("treats a missing agreement as a draft", () => {
    expect(isDraftAgreement(null)).toBe(true);
    expect(isDraftAgreement(undefined)).toBe(true);
  });

  it("is a draft while unstamped and unexecuted", () => {
    expect(isDraftAgreement({ status: "draft" })).toBe(true);
    expect(isDraftAgreement({ status: "sent" })).toBe(true);
    expect(isDraftAgreement({ status: "signing" })).toBe(true);
  });

  it("is final once the company stamp has been applied", () => {
    expect(isDraftAgreement({ status: "sent", stamp_reference: "SEAL-ABC123" })).toBe(false);
  });

  it("is final once a signed document exists", () => {
    // Covers both Leegality e-sign and a manually uploaded countersigned copy.
    expect(isDraftAgreement({ status: "signing", signed_document_id: "doc-1" })).toBe(false);
  });

  it("is final when the agreement has executed", () => {
    expect(isDraftAgreement({ status: "executed" })).toBe(false);
  });
});

describe("applyDraftWatermark", () => {
  it("returns a valid PDF with the same page count", async () => {
    const original = await blankPdf(3);
    const marked = await applyDraftWatermark(original);
    const reloaded = await PDFDocument.load(marked);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("changes the document — the mark is actually drawn", async () => {
    const original = await blankPdf(1);
    const marked = await applyDraftWatermark(original);
    expect(Buffer.from(marked).equals(Buffer.from(original))).toBe(false);
  });

  it("returns the input unchanged rather than throwing on an unreadable PDF", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await applyDraftWatermark(garbage);
    expect(Buffer.from(out).equals(Buffer.from(garbage))).toBe(true);
    spy.mockRestore();
  });

  it("accepts a Buffer as well as a Uint8Array", async () => {
    const original = Buffer.from(await blankPdf(1));
    const marked = await applyDraftWatermark(original);
    await expect(PDFDocument.load(marked)).resolves.toBeDefined();
  });
});

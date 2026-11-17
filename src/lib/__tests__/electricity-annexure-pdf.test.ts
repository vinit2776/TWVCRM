import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { appendElectricityAnnexure } from "@/lib/electricity-annexure-pdf";
import type { ElectricityAnnexure } from "@/lib/electricity-annexure";

async function basePdf(pages: number): Promise<Buffer> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage();
  return Buffer.from(await d.save());
}

const annexure: ElectricityAnnexure = {
  monthLabel: "September 2026",
  totalUnits: 100,
  utilityPct: 80,
  generatorPct: 20,
  lines: [{ label: "Meter 1", units: 100, rate: 10, amount: 1000 }],
  subtotal: 1000,
  gstRate: 18,
  cgst: 90,
  sgst: 90,
  roundOff: 0,
  total: 1180,
};

describe("appendElectricityAnnexure", () => {
  it("adds exactly one page when an annexure is present", async () => {
    const out = await appendElectricityAnnexure(await basePdf(2), { invoiceNumber: "A/1", contractNumber: "TWV-C-1", annexure });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(3);
  });
  it("is a no-op without an annexure", async () => {
    const base = await basePdf(2);
    const out = await appendElectricityAnnexure(base, { invoiceNumber: "A/1", contractNumber: "TWV-C-1" });
    expect(out).toBe(base);
  });
  it("returns the input unchanged if the base is not a valid PDF", async () => {
    const junk = Buffer.from("not a pdf");
    const out = await appendElectricityAnnexure(junk, { invoiceNumber: "A/1", contractNumber: "TWV-C-1", annexure });
    expect(out).toBe(junk);
  });
});

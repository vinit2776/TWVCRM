import { describe, it, expect } from "vitest";
import { sanitizeForPdf } from "../pdf-text";

describe("sanitizeForPdf", () => {
  it("replaces the rupee sign that garbled the TWV-C-0044 invoice line", () => {
    expect(sanitizeForPdf("B&W print, September 2026: 88 over quota at ₹5")).toBe("B&W print, September 2026: 88 over quota at Rs.5");
  });
  it("normalises smart punctuation and drops what the font cannot draw", () => {
    expect(sanitizeForPdf("Print — “Sep” … done")).toBe('Print - "Sep" ... done');
    expect(sanitizeForPdf("ok ✓ text")).toBe("ok  text");
  });
  it("leaves plain text and newlines alone", () => {
    expect(sanitizeForPdf("Colour print, September 2026\n4 pages used x Rs. 15")).toBe("Colour print, September 2026\n4 pages used x Rs. 15");
  });
});

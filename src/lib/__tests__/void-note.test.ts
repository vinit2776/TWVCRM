import { describe, it, expect } from "vitest";
import { parseReissueNote } from "../void-note";

describe("parseReissueNote", () => {
  it("reads the current 'Replaces voided' format", () => {
    expect(parseReissueNote("Replaces voided TWV-BS-0383.\nVoid reason: typo in rate"))
      .toEqual({ voidedNumber: "TWV-BS-0383", reason: "typo in rate" });
  });

  it("reads the legacy 'Re-issued from voided' format (e.g. the 1 Sept incident notes)", () => {
    const legacy =
      "Re-issued from voided TWV-BS-0367.\nOriginal void reason: Voided — generated in error by an internal script (2026-09-01). No payments were recorded against this statement.";
    expect(parseReissueNote(legacy)).toEqual({
      voidedNumber: "TWV-BS-0367",
      reason: "Voided — generated in error by an internal script (2026-09-01). No payments were recorded against this statement.",
    });
  });

  it("keeps a multi-line reason intact", () => {
    expect(parseReissueNote("Replaces voided TWV-BS-0001.\nVoid reason: line one\nline two")?.reason)
      .toBe("line one\nline two");
  });

  it("leaves ordinary notes alone", () => {
    expect(parseReissueNote("Customer asked for PO number on the invoice")).toBeNull();
    expect(parseReissueNote("")).toBeNull();
  });
});

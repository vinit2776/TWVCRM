import { describe, it, expect } from "vitest";
import { normalizeRenewalNote, RENEWAL_NOTE_MAX_LENGTH } from "@/lib/renewal-note";

describe("normalizeRenewalNote", () => {
  it("treats absent, null and blank as no note", () => {
    expect(normalizeRenewalNote(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeRenewalNote(null)).toEqual({ ok: true, value: null });
    expect(normalizeRenewalNote("")).toEqual({ ok: true, value: null });
    expect(normalizeRenewalNote("   \n  ")).toEqual({ ok: true, value: null });
  });

  it("trims surrounding whitespace and keeps the text", () => {
    expect(normalizeRenewalNote("  Held rate in return for 2 more seats  ")).toEqual({
      ok: true,
      value: "Held rate in return for 2 more seats",
    });
  });

  it("keeps line breaks inside the note", () => {
    expect(normalizeRenewalNote("Asked 10%.\nAgreed 5%.")).toEqual({ ok: true, value: "Asked 10%.\nAgreed 5%." });
  });

  it("accepts a note exactly at the limit", () => {
    const note = "a".repeat(RENEWAL_NOTE_MAX_LENGTH);
    expect(normalizeRenewalNote(note)).toEqual({ ok: true, value: note });
  });

  it("rejects a note over the limit instead of cutting it off", () => {
    const result = normalizeRenewalNote("a".repeat(RENEWAL_NOTE_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
  });

  it("measures the limit after trimming", () => {
    const padded = ` ${"a".repeat(RENEWAL_NOTE_MAX_LENGTH)} `;
    expect(normalizeRenewalNote(padded).ok).toBe(true);
  });

  it("rejects values that are not text", () => {
    expect(normalizeRenewalNote(42).ok).toBe(false);
    expect(normalizeRenewalNote({ note: "x" }).ok).toBe(false);
    expect(normalizeRenewalNote(["x"]).ok).toBe(false);
  });
});

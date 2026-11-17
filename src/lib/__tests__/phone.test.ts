import { describe, it, expect } from "vitest";
import { normalizePhoneFields, normalizeStoredPhone } from "@/lib/phone";

describe("normalizeStoredPhone", () => {
  it("stores an Indian number as its 10 digits however it was typed", () => {
    for (const raw of ["9876543210", "98765 43210", "98765-43210", "+91 98765 43210", "+919876543210", "919876543210", "09876543210", " (98765) 43210 "]) {
      expect(normalizeStoredPhone(raw)).toBe("9876543210");
    }
  });
  it("keeps an international number with its +", () => {
    expect(normalizeStoredPhone("+1 415 555 0123")).toBe("+14155550123");
  });
  it("keeps other lengths as plain digits rather than guessing", () => {
    expect(normalizeStoredPhone("080 4123 4567")).toBe("8041234567");
    expect(normalizeStoredPhone("12345")).toBe("12345");
  });
  it("returns empty for blank or digitless input", () => {
    expect(normalizeStoredPhone("")).toBe("");
    expect(normalizeStoredPhone(null)).toBe("");
    expect(normalizeStoredPhone("n/a")).toBe("");
  });
});

describe("normalizePhoneFields", () => {
  it("normalises only the phone fields that are present", () => {
    expect(normalizePhoneFields({ mobile: "98765 43210", first_name: "A" })).toEqual({ mobile: "9876543210", first_name: "A" });
  });
});

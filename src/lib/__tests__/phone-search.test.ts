import { describe, it, expect } from "vitest";
import { phoneMatchClauses, phoneSearchDigits } from "@/lib/phone-search";

// The clause is a Postgres regex; JS regex semantics are identical for this pattern.
const matches = (term: string, stored: string) =>
  phoneMatchClauses(term, ["phone"]).some((c) =>
    new RegExp(c.replace("phone.match.", "")).test(stored),
  );

describe("phoneSearchDigits", () => {
  it("returns digits for phone-like terms", () => {
    expect(phoneSearchDigits("00000 00000")).toBe("0000000000");
    expect(phoneSearchDigits("98765-43210")).toBe("9876543210");
  });
  it("keeps the last 10 digits when a country code is typed", () => {
    expect(phoneSearchDigits("+91 98765 43210")).toBe("9876543210");
  });
  it("ignores names, emails and very short numbers", () => {
    expect(phoneSearchDigits("Meera")).toBeNull();
    expect(phoneSearchDigits("a@b.com")).toBeNull();
    expect(phoneSearchDigits("123")).toBeNull();
    expect(phoneSearchDigits("TWV-E-42")).toBeNull();
  });
});

describe("phoneMatchClauses", () => {
  it("finds a spaced number from an unspaced search, and the reverse", () => {
    expect(matches("0000000000", "00000 00000")).toBe(true);
    expect(matches("00000 00000", "0000000000")).toBe(true);
    expect(matches("9876543210", "+91-98765-43210")).toBe(true);
  });
  it("matches a partial run of digits", () => {
    expect(matches("65432", "98765 43210")).toBe(true);
  });
  it("does not match digits that are not contiguous", () => {
    expect(matches("1234", "1 2 5 3 4")).toBe(false);
    expect(matches("1234", "10203 4")).toBe(false);
  });
  it("produces nothing for non-phone terms", () => {
    expect(phoneMatchClauses("Meera", ["phone", "mobile"])).toEqual([]);
  });
});

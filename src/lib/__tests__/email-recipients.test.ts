import { describe, it, expect } from "vitest";
import { parseEmailList, validateRecipients } from "../email-recipients";

describe("parseEmailList", () => {
  it("splits on commas, semicolons and spaces and removes duplicates", () => {
    const r = parseEmailList("a@x.com, b@y.com; A@x.com  c@z.com");
    expect(r.emails).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(r.invalid).toEqual([]);
  });

  it("reports addresses that do not look valid", () => {
    expect(parseEmailList("a@x.com, nope").invalid).toEqual(["nope"]);
  });
});

describe("validateRecipients", () => {
  it("returns nothing to override when the fields are empty", () => {
    expect(validateRecipients({})).toEqual({ ok: true, to: null, cc: [] });
  });

  it("takes a new primary and a cc list, never repeating the primary in cc", () => {
    const r = validateRecipients({ to: "me@x.com", cc: "boss@x.com, ME@x.com" });
    expect(r).toEqual({ ok: true, to: "me@x.com", cc: ["boss@x.com"] });
  });

  it("accepts cc as an array", () => {
    expect(validateRecipients({ cc: ["a@x.com", "b@y.com"] })).toEqual({ ok: true, to: null, cc: ["a@x.com", "b@y.com"] });
  });

  it("rejects a bad primary or a bad cc address with a clear message", () => {
    expect(validateRecipients({ to: "nope" }).ok).toBe(false);
    const r = validateRecipients({ cc: "good@x.com, bad" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bad");
  });

  it("caps cc", () => {
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(",");
    expect(validateRecipients({ cc: many }).ok).toBe(false);
  });
});

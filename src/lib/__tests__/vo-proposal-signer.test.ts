import { describe, it, expect } from "vitest";
import { signerSchema, withdrawReasonSchema, voProposalViewUrl, signerForDisplay } from "../vo-proposal-signer";

describe("signerSchema", () => {
  it("accepts and normalises a valid signer", () => {
    const r = signerSchema.safeParse({ name: "  Asha Rao ", email: "Asha@Example.COM", phone: "+91 97910 97900" });
    expect(r.success && r.data).toEqual({ name: "Asha Rao", email: "asha@example.com", phone: "+91 97910 97900" });
  });
  it.each([
    { name: "A", email: "a@b.co", phone: "9791097900" },
    { name: "Asha", email: "nope", phone: "9791097900" },
    { name: "Asha", email: "a@b.co", phone: "123" },
    { name: "Asha", email: "a@b.co", phone: "abcdefghijkl" },
  ])("rejects %j", (v) => expect(signerSchema.safeParse(v).success).toBe(false));
});

describe("withdrawReasonSchema", () => {
  it("requires a real reason", () => {
    expect(withdrawReasonSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(withdrawReasonSchema.safeParse({ reason: "ok" }).success).toBe(false);
    expect(withdrawReasonSchema.safeParse({ reason: "Customer went elsewhere" }).success).toBe(true);
  });
});

describe("voProposalViewUrl", () => {
  it("builds the public link without query strings", () => {
    expect(voProposalViewUrl("abc", "https://x.test/")).toBe("https://x.test/vo-proposal/abc");
    expect(voProposalViewUrl("abc", undefined)).toBe("https://crm.theworkvilla.com/vo-proposal/abc");
  });
});

describe("signerForDisplay", () => {
  it("is null when nothing was captured", () => expect(signerForDisplay({})).toBeNull());
  it("returns captured fields", () =>
    expect(signerForDisplay({ signer_name: "A B", signer_email: "a@b.co" })).toEqual({ name: "A B", email: "a@b.co", phone: "" }));
});

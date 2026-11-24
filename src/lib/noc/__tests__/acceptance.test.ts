import { describe, expect, it } from "vitest";
import {
  acceptedWordsCanonical, maskEmail, matchSignatory, otpSendDecision, otpVerifyDecision, OTP_MAX_ATTEMPTS, REQUIRED_TICKS,
  serviceTerms, validateAcceptance, type AcceptedWords,
} from "../acceptance";
import { isRealProduction, isReservedTestAddress, unsafeRecipientReason } from "../safe-send";

const words: AcceptedWords = { purpose: "roc", company: "ANIQA GLITZ PRIVATE LIMITED", centre: "Perungudi", address: "Chennai", feeTotal: 23600, validUntil: "2027-08-31", agreementDate: "2026-08-13" };

describe("what the customer accepted", () => {
  it("has four boxes: the three printed paragraphs and the service terms", () => expect(REQUIRED_TICKS).toBe(4));

  it("changes if anything they saw changes, so a hash of it proves the exact words", () => {
    const base = acceptedWordsCanonical(words);
    expect(acceptedWordsCanonical(words)).toBe(base);
    expect(acceptedWordsCanonical({ ...words, feeTotal: 24000 })).not.toBe(base);
    expect(acceptedWordsCanonical({ ...words, purpose: "gst" })).not.toBe(base);
    expect(acceptedWordsCanonical({ ...words, validUntil: "2027-09-30" })).not.toBe(base);
    expect(base).toContain("NOC-T1");
    expect(base).toContain("indemnify");
  });

  it("names the validity in the service terms", () => {
    expect(serviceTerms("31 Aug 2027")).toContain("31 Aug 2027");
    expect(serviceTerms("31 Aug 2027")).toContain("not refundable");
  });
});

describe("tying the click to a named person", () => {
  it("matches the signatory on the agreement, ignoring case, titles and order", () => {
    expect(matchSignatory("Mohamed Arshad", "MOHAMED ARSHAD")).toBe("matches");
    expect(matchSignatory("Mr. Arshad Mohamed", "Mohamed Arshad")).toBe("matches");
    expect(matchSignatory("Arshad", "Mohamed Arshad")).toBe("matches");
  });
  it("flags a different person and a missing record", () => {
    expect(matchSignatory("Priya Raman", "Mohamed Arshad")).toBe("mismatch");
    expect(matchSignatory("Mohamed Ali", "Mohamed Arshad")).toBe("partial");
    expect(matchSignatory("Anyone", "")).toBe("no_record");
    expect(matchSignatory("Anyone", null)).toBe("no_record");
  });
});

describe("validateAcceptance", () => {
  const ok = { name: "Mohamed Arshad", designation: "Director", ticks: [true, true, true, true], code: "123456" };
  it("accepts a complete acceptance", () => expect(validateAcceptance(ok)).toEqual([]));
  it("needs name, designation, every box and a 6-digit code", () => {
    expect(validateAcceptance({}).length).toBe(4);
    expect(validateAcceptance({ ...ok, ticks: [true, true, true, false] })[0]).toContain("Tick every box");
    expect(validateAcceptance({ ...ok, ticks: [true, true, true] })[0]).toContain("Tick every box");
    expect(validateAcceptance({ ...ok, code: "12ab56" })[0]).toContain("6-digit");
  });
});

describe("one-time code", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const row = (over = {}) => ({ code_hash: "h1", attempts: 0, expires_at: "2026-11-24T12:05:00Z", verified_at: null, ...over });

  it("accepts the right code inside its time and attempts", () => expect(otpVerifyDecision(row(), "h1", now)).toEqual({ ok: true }));
  it("refuses a wrong, expired or locked code and a missing one", () => {
    expect(otpVerifyDecision(row(), "nope", now)).toMatchObject({ ok: false, reason: "wrong" });
    expect(otpVerifyDecision(row({ expires_at: "2026-11-24T11:59:00Z" }), "h1", now)).toMatchObject({ reason: "expired" });
    expect(otpVerifyDecision(row({ attempts: OTP_MAX_ATTEMPTS }), "h1", now)).toMatchObject({ reason: "locked" });
    expect(otpVerifyDecision(null, "h1", now)).toMatchObject({ reason: "none" });
  });
  it("limits how many codes can be sent in a short window", () => {
    expect(otpSendDecision([], now)).toEqual({ ok: true });
    const t = (m: number) => new Date(now - m * 60_000).toISOString();
    expect(otpSendDecision([t(1), t(2)], now)).toEqual({ ok: true });
    expect(otpSendDecision([t(1), t(2), t(3)], now)).toMatchObject({ ok: false });
    expect(otpSendDecision([t(11), t(12), t(13)], now)).toEqual({ ok: true });
  });
  it("masks the address it was sent to", () => {
    expect(maskEmail("arshad@example.com")).toBe("a****@example.com");
    expect(maskEmail("a@example.com")).toBe("a*@example.com");
  });
});

describe("safe send: testing can never message a real customer", () => {
  it("allows only reserved test addresses outside production", () => {
    expect(isReservedTestAddress("x@example.com")).toBe(true);
    expect(isReservedTestAddress("x@thing.test")).toBe(true);
    expect(isReservedTestAddress("customer@gmail.com")).toBe(false);
    expect(unsafeRecipientReason("customer@gmail.com", false)).toContain("Not sent");
    expect(unsafeRecipientReason("a@example.com", false)).toBeNull();
  });
  it("is a no-op in production", () => expect(unsafeRecipientReason("customer@gmail.com", true)).toBeNull());
});

describe("what counts as the live system", () => {
  it("needs a production build, a Vercel production deploy AND the production database", () => {
    expect(isRealProduction({ nodeEnv: "production", vercelEnv: "production", productionDatabase: true })).toBe(true);
  });
  it("is never true on a developer's machine, even when .env.local says VERCEL_ENV=production", () => {
    expect(isRealProduction({ nodeEnv: "development", vercelEnv: "production", productionDatabase: true })).toBe(false);
    expect(isRealProduction({ nodeEnv: "development", vercelEnv: "production", productionDatabase: false })).toBe(false);
  });
  it("is false for a preview deploy, and for a production build on the staging database", () => {
    expect(isRealProduction({ nodeEnv: "production", vercelEnv: "preview", productionDatabase: false })).toBe(false);
    expect(isRealProduction({ nodeEnv: "production", vercelEnv: "production", productionDatabase: false })).toBe(false);
    expect(isRealProduction({ nodeEnv: "production", vercelEnv: undefined, productionDatabase: true })).toBe(false);
  });
});

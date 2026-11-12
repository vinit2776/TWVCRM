import { describe, expect, it } from "vitest";
import { applyLabelToKind, isNumberLabel, labelSilencesNumber, last10Of, shouldHoldForReview } from "@/lib/whatsapp-gate";

describe("labelSilencesNumber", () => {
  it("silences staff, vendor and not_lead only", () => {
    expect(labelSilencesNumber("staff")).toBe(true);
    expect(labelSilencesNumber("vendor")).toBe(true);
    expect(labelSilencesNumber("not_lead")).toBe(true);
    expect(labelSilencesNumber("customer_team")).toBe(false);
    expect(labelSilencesNumber(null)).toBe(false);
  });
});

describe("applyLabelToKind", () => {
  it("turns enquiry-like kinds into customer for a customer's team member", () => {
    for (const k of ["enquiry", "unsure", "spam", "low_signal"] as const) {
      expect(applyLabelToKind("customer_team", k)).toBe("customer");
    }
  });
  it("keeps complaints reaching the complaint lane", () => {
    expect(applyLabelToKind("customer_team", "complaint")).toBe("complaint");
  });
  it("leaves unlabelled numbers alone", () => {
    expect(applyLabelToKind(null, "enquiry")).toBe("enquiry");
  });
});

describe("shouldHoldForReview", () => {
  const base = { kind: "unsure" as const, hasReferral: false, isCustomer: false, continuesConversation: false };

  it("holds an unclear message from any non-customer number, known or not", () => {
    expect(shouldHoldForReview(base)).toBe(true);
  });
  it("never holds an ad reply, a customer, or a message continuing a conversation", () => {
    expect(shouldHoldForReview({ ...base, hasReferral: true })).toBe(false);
    expect(shouldHoldForReview({ ...base, isCustomer: true })).toBe(false);
    expect(shouldHoldForReview({ ...base, continuesConversation: true })).toBe(false);
  });
  it("only holds unclear messages", () => {
    expect(shouldHoldForReview({ ...base, kind: "enquiry" })).toBe(false);
    expect(shouldHoldForReview({ ...base, kind: "spam" })).toBe(false);
  });
});

describe("helpers", () => {
  it("keys numbers by their last 10 digits", () => {
    expect(last10Of("+91 98765-43210")).toBe("9876543210");
  });
  it("validates labels", () => {
    expect(isNumberLabel("vendor")).toBe(true);
    expect(isNumberLabel("friend")).toBe(false);
  });
});

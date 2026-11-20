import { describe, it, expect } from "vitest";
import {
  draftSendGate,
  parseDraftGateMode,
  isCustomerAccepted,
  isMissingColumn,
} from "@/lib/vo-draft-gate";

describe("parseDraftGateMode", () => {
  it("defaults to off", () => {
    expect(parseDraftGateMode(null)).toBe("off");
    expect(parseDraftGateMode(undefined)).toBe("off");
    expect(parseDraftGateMode("")).toBe("off");
    expect(parseDraftGateMode("garbage")).toBe("off");
  });
  it("recognises enforce", () => expect(parseDraftGateMode("enforce")).toBe("enforce"));
});

describe("draftSendGate", () => {
  const base = { accepted: true, kycReviewed: true, role: "sales_rep", mode: "enforce" as const };

  it("allows everything when the mode is off", () => {
    const r = draftSendGate({ accepted: false, kycReviewed: false, role: "fms", mode: "off" });
    expect(r).toEqual({ allowed: true, reason: null });
  });
  it("allows an accepted, KYC-reviewed draft", () => {
    expect(draftSendGate(base).allowed).toBe(true);
  });
  it("blocks before acceptance", () => {
    const r = draftSendGate({ ...base, accepted: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/accepted/);
  });
  it("blocks when KYC is not reviewed", () => {
    const r = draftSendGate({ ...base, kycReviewed: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/KYC/);
  });
  it("treats an unenforceable KYC (column missing) as allowed", () => {
    expect(draftSendGate({ ...base, kycReviewed: null }).allowed).toBe(true);
  });
  it("still requires acceptance when KYC is unenforceable", () => {
    expect(draftSendGate({ ...base, kycReviewed: null, accepted: false }).allowed).toBe(false);
  });
  it("blocks roles outside the send roles", () => {
    expect(draftSendGate({ ...base, role: "accounts" }).allowed).toBe(false);
    expect(draftSendGate({ ...base, role: null }).allowed).toBe(false);
  });
  it("allows admin and manager", () => {
    expect(draftSendGate({ ...base, role: "admin" }).allowed).toBe(true);
    expect(draftSendGate({ ...base, role: "manager" }).allowed).toBe(true);
  });
});

describe("isCustomerAccepted", () => {
  it("is false while the case and agreement are pre-approval", () => {
    expect(isCustomerAccepted({ caseStatus: "sent_for_client_approval", agreementStatus: "sent_to_client" })).toBe(false);
    expect(isCustomerAccepted({})).toBe(false);
  });
  it("is true when the agreement is client_approved or later", () => {
    for (const s of ["client_approved", "signing", "executed"]) {
      expect(isCustomerAccepted({ agreementStatus: s })).toBe(true);
    }
  });
  it("is true when the case is client_approved or later", () => {
    for (const s of ["client_approved", "signing_in_progress", "active"]) {
      expect(isCustomerAccepted({ caseStatus: s })).toBe(true);
    }
  });
});

describe("isMissingColumn", () => {
  it("matches only Postgres 42703", () => {
    expect(isMissingColumn({ code: "42703" })).toBe(true);
    expect(isMissingColumn({ code: "42P01" })).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";

// The module wires up mail/push/whatsapp clients at import; only the pure helpers are under test.
vi.mock("@/lib/mailer", () => ({ resend: {}, EMAIL_FROM: "x" }));
vi.mock("@/lib/push", () => ({ sendPushToAll: vi.fn() }));
vi.mock("@/lib/whatsapp", () => ({ messaging: {} }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { isInboundEvent, normaliseWhatsAppNumber, splitName } from "../whatsapp-intake";

describe("normaliseWhatsAppNumber", () => {
  it("strips the 91 country code to the 10 digits the forms store", () => {
    expect(normaliseWhatsAppNumber("919876543210")).toEqual({ mobile: "9876543210", last10: "9876543210" });
  });
  it("keeps the full number for a non-Indian sender", () => {
    expect(normaliseWhatsAppNumber("14155550123")).toEqual({ mobile: "14155550123", last10: "4155550123" });
  });
  it("rejects too-short input", () => {
    expect(normaliseWhatsAppNumber("12345")).toBeNull();
  });
});

describe("splitName", () => {
  it("falls back to a placeholder and uses '-' for a missing surname", () => {
    expect(splitName(null)).toEqual({ first: "WhatsApp contact", last: "-" });
    expect(splitName("Asha")).toEqual({ first: "Asha", last: "-" });
    expect(splitName("Asha Nair Iyer")).toEqual({ first: "Asha", last: "Nair Iyer" });
  });
});

describe("isInboundEvent", () => {
  it("treats a status-less event as inbound (original MSG91 shape)", () => {
    expect(isInboundEvent({ from: "91900", text: "hi" }, undefined, undefined)).toBe(true);
  });
  it("treats the re-registered shape (status submitted, direction inbound, no requestId) as inbound", () => {
    expect(isInboundEvent({ eventName: "submitted", direction: "inbound" }, "submitted", undefined)).toBe(true);
  });
  it("never treats an event carrying a requestId as inbound, so delivery reports stay reports", () => {
    expect(isInboundEvent({ direction: "inbound" }, "sent", "abc123")).toBe(false);
  });
  it("rejects a status event with an outbound or missing direction", () => {
    expect(isInboundEvent({ direction: "outbound" }, "submitted", undefined)).toBe(false);
    expect(isInboundEvent({}, "submitted", undefined)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  INVOICE_CHECK_REASONS,
  invoiceCheckFailureMessage,
  isInvoiceCheckReason,
  reasonFromError,
  reasonFromHttpStatus,
} from "../procurement/invoice-check-reasons";

describe("reasonFromError", () => {
  it("maps model-side statuses", () => {
    expect(reasonFromError({ status: 413 })).toBe("too_large");
    expect(reasonFromError({ status: 400 })).toBe("unreadable");
  });
  it("treats auth, credit, rate, server and network errors as service_error", () => {
    for (const status of [401, 402, 403, 429, 500, 529]) expect(reasonFromError({ status })).toBe("service_error");
    expect(reasonFromError(new Error("timeout"))).toBe("service_error");
    expect(reasonFromError(null)).toBe("service_error");
  });
});

describe("reasonFromHttpStatus", () => {
  it("maps route statuses", () => {
    expect(reasonFromHttpStatus(401)).toBe("no_permission");
    expect(reasonFromHttpStatus(403)).toBe("no_permission");
    expect(reasonFromHttpStatus(413)).toBe("too_large");
    expect(reasonFromHttpStatus(415)).toBe("unsupported_type");
    expect(reasonFromHttpStatus(429)).toBe("rate_limited");
    expect(reasonFromHttpStatus(500)).toBe("service_error");
  });
});

describe("messages", () => {
  it("has a plain sentence for every reason", () => {
    for (const r of INVOICE_CHECK_REASONS) {
      const m = invoiceCheckFailureMessage(r);
      expect(m.startsWith("Couldn't read this invoice automatically — ")).toBe(true);
      expect(m.endsWith("Enter the figures manually.")).toBe(true);
      expect(m.toLowerCase()).not.toContain("please");
    }
    expect(invoiceCheckFailureMessage("not_configured")).toContain("isn't set up");
  });
  it("validates reason strings", () => {
    expect(isInvoiceCheckReason("rate_limited")).toBe(true);
    expect(isInvoiceCheckReason("nope")).toBe(false);
    expect(isInvoiceCheckReason(undefined)).toBe(false);
  });
});

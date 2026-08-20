import { describe, it, expect } from "vitest";
import {
  canReviewPaymentReport,
  defaultNeededBy,
  describeReport,
  isPaymentReportOutcome,
  statusForOutcome,
  validatePaymentReport,
  MAX_AGE_DAYS,
  type PaymentReportFields,
} from "@/lib/queries/payment-reports";

const TODAY = new Date("2026-08-20T09:00:00Z");

function valid(overrides: Record<string, unknown> = {}) {
  return {
    amount: "48380",
    paid_on: "2026-08-19",
    payment_mode: "neft",
    ...overrides,
  };
}

describe("validatePaymentReport", () => {
  it("accepts a plain bank transfer and rounds to paise", () => {
    const res = validatePaymentReport(valid({ amount: "48380.005" }), TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.amount).toBe(48380.01);
    expect(res.value.payment_mode).toBe("neft");
    expect(res.value.payer_differs).toBe(false);
  });

  it("rejects a zero or negative amount", () => {
    for (const amount of ["0", "-100", "abc", ""]) {
      expect(validatePaymentReport(valid({ amount }), TODAY).ok).toBe(false);
    }
  });

  it("rejects a payment mode outside the shared statement list", () => {
    const res = validatePaymentReport(valid({ payment_mode: "barter" }), TODAY);
    expect(res.ok).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(validatePaymentReport(valid({ paid_on: "19-08-2026" }), TODAY).ok).toBe(false);
    expect(validatePaymentReport(valid({ paid_on: "2026-13-40" }), TODAY).ok).toBe(false);
  });

  it("allows today and yesterday but not next week", () => {
    expect(validatePaymentReport(valid({ paid_on: "2026-08-20" }), TODAY).ok).toBe(true);
    // One day of slack absorbs a timezone edge, not a genuine future date.
    expect(validatePaymentReport(valid({ paid_on: "2026-08-21" }), TODAY).ok).toBe(true);
    expect(validatePaymentReport(valid({ paid_on: "2026-08-27" }), TODAY).ok).toBe(false);
  });

  it("rejects payments older than the reporting window", () => {
    const old = new Date(TODAY);
    old.setDate(old.getDate() - (MAX_AGE_DAYS + 1));
    const res = validatePaymentReport(valid({ paid_on: old.toISOString().slice(0, 10) }), TODAY);
    expect(res.ok).toBe(false);
  });

  it("keeps the reference optional — a screenshot without a UTR is still worth reporting", () => {
    const res = validatePaymentReport(valid({ payment_reference: "   " }), TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payment_reference).toBeNull();
  });

  it("refuses a differing-payer tick with no name, since that names no account to look for", () => {
    const res = validatePaymentReport(valid({ payer_differs: true, payer_name: "  " }), TODAY);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/name on the account/i);
  });

  it("accepts a differing payer when the account is named", () => {
    const res = validatePaymentReport(
      valid({ payer_differs: true, payer_name: " R. Menon " }),
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payer_name).toBe("R. Menon");
    expect(res.value.payer_differs).toBe(true);
  });

  it("treats the string 'true' from multipart form data as a tick", () => {
    const res = validatePaymentReport(
      valid({ payer_differs: "true", payer_name: "Sister Concern Pvt Ltd" }),
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payer_differs).toBe(true);
  });
});

describe("statusForOutcome", () => {
  it("verifies and rejects into settled statuses", () => {
    expect(statusForOutcome("verified")).toBe("verified");
    expect(statusForOutcome("rejected")).toBe("rejected");
  });

  it("leaves 'not found yet' at reported, so the chase cron keeps working it", () => {
    // This is the whole reason not_found exists as a separate outcome: if it
    // settled the report, "I can't see it yet" would silently stop the chase.
    expect(statusForOutcome("not_found")).toBe("reported");
  });

  it("recognises only the three outcomes", () => {
    expect(isPaymentReportOutcome("verified")).toBe(true);
    expect(isPaymentReportOutcome("not_found")).toBe(true);
    expect(isPaymentReportOutcome("resolved")).toBe(false);
    expect(isPaymentReportOutcome(null)).toBe(false);
  });
});

describe("canReviewPaymentReport", () => {
  it("lets accounts and admin confirm a bank credit", () => {
    expect(canReviewPaymentReport("accounts")).toBe(true);
    expect(canReviewPaymentReport("admin")).toBe(true);
  });

  it("keeps everyone else out, including the manager who can record payments", () => {
    for (const role of ["manager", "sales_rep", "floor_manager", "office_admin", "fms", "viewer", null]) {
      expect(canReviewPaymentReport(role)).toBe(false);
    }
  });
});

describe("defaultNeededBy", () => {
  it("gives accounts two days before the thread starts chasing", () => {
    expect(defaultNeededBy(new Date("2026-08-20T09:00:00Z"))).toBe("2026-08-22");
  });

  it("rolls over a month boundary", () => {
    expect(defaultNeededBy(new Date("2026-08-30T09:00:00Z"))).toBe("2026-09-01");
  });
});

describe("describeReport", () => {
  const base: PaymentReportFields = {
    amount: 48380,
    paid_on: "2026-08-19",
    payment_mode: "neft",
    payment_reference: null,
    payer_name: null,
    payer_differs: false,
  };

  it("summarises the essentials for a notification body", () => {
    expect(describeReport(base, "NEFT")).toBe("₹48,380 · NEFT · 2026-08-19");
  });

  it("surfaces the remitter, which is the part accounts can't work out alone", () => {
    const line = describeReport(
      { ...base, payment_reference: "HDFC0938271", payer_differs: true, payer_name: "R. Menon" },
      "NEFT",
    );
    expect(line).toContain("ref HDFC0938271");
    expect(line).toContain("from R. Menon");
  });
});

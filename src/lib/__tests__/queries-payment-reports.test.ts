import { describe, it, expect } from "vitest";
import {
  canReviewPaymentReport,
  targetKindForEntity,
  PAYMENT_REPORT_ENTITY_TYPES,
  defaultNeededBy,
  describeReport,
  isPaymentReportOutcome,
  statusForOutcome,
  validatePaymentReport,
  lastCheckedChip,
  matchingRecordedPayments,
  closedReportSummary,
  MAX_AGE_DAYS,
  type PaymentReportFields,
} from "@/lib/queries/payment-reports";
import { statementReference } from "@/lib/receivables";

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


describe("targetKindForEntity", () => {
  it("treats a proposal deposit as a deposit, everything else as an invoice", () => {
    expect(targetKindForEntity("proposal_deposit")).toBe("deposit");
    expect(targetKindForEntity("contract")).toBe("invoice");
    expect(targetKindForEntity("billing_statement")).toBe("invoice");
  });

  it("classifies every reportable entity type", () => {
    // Guards the next entity type someone adds: if it isn't classified here
    // it silently defaults to 'invoice', and an invoice-shaped report on a
    // deposit would demand a billing_payments row that can never exist.
    for (const t of PAYMENT_REPORT_ENTITY_TYPES) {
      expect(["invoice", "deposit"]).toContain(targetKindForEntity(t));
    }
  });
});


describe("statementReference", () => {
  it("prefers the GST invoice number once one exists", () => {
    expect(statementReference({ statement_number: "TWV-BS-0103", gst_invoice_number: "TWV/INV/26-27/0004" }))
      .toBe("TWV/INV/26-27/0004");
  });

  it("falls back to the statement number before one is issued", () => {
    expect(statementReference({ statement_number: "TWV-BS-0176", gst_invoice_number: null }))
      .toBe("TWV-BS-0176");
  });

  it("never renders an empty label", () => {
    expect(statementReference({ statement_number: null, gst_invoice_number: null })).toBe("Draft");
    expect(statementReference({})).toBe("Draft");
  });
});

describe("lastCheckedChip", () => {
  const now = Date.parse("2026-10-15T08:00:00Z");
  const ago = (days: number) => new Date(now - days * 86_400_000 - 1000).toISOString();

  it("says not checked when accounts have never answered not-found", () => {
    expect(lastCheckedChip(null, now)).toEqual({ label: "not checked yet", tone: "never" });
    expect(lastCheckedChip(undefined, now).tone).toBe("never");
  });

  it("is fresh today and yesterday", () => {
    expect(lastCheckedChip(new Date(now - 3_600_000).toISOString(), now)).toEqual({
      label: "checked today",
      tone: "fresh",
    });
    expect(lastCheckedChip(ago(1), now)).toEqual({ label: "checked yesterday", tone: "fresh" });
  });

  it("goes stale from two days on, with the day count", () => {
    expect(lastCheckedChip(ago(5), now)).toEqual({ label: "checked 5 days ago", tone: "stale" });
  });

  it("never reports a negative age for a clock-skewed timestamp", () => {
    expect(lastCheckedChip(new Date(now + 86_400_000).toISOString(), now).label).toBe("checked today");
  });
});

describe("matchingRecordedPayments", () => {
  const pay = (id: string, amount: number, tds = 0) => ({ id, amount, tds_amount: tds });

  it("finds the one recorded payment that equals the report", () => {
    const m = matchingRecordedPayments([pay("a", 10000), pay("b", 6372)], 6372);
    expect(m.map((p) => p.id)).toEqual(["b"]);
  });

  it("counts TDS as part of the credit, as settlement does", () => {
    const m = matchingRecordedPayments([pay("a", 9000, 1000)], 10000);
    expect(m.map((p) => p.id)).toEqual(["a"]);
  });

  it("tolerates a rupee of rounding but no more", () => {
    expect(matchingRecordedPayments([pay("a", 6372.6)], 6372)).toHaveLength(1);
    expect(matchingRecordedPayments([pay("a", 6374)], 6372)).toHaveLength(0);
  });

  it("returns every candidate when several match, so a person has to choose", () => {
    expect(matchingRecordedPayments([pay("a", 500), pay("b", 500)], 500)).toHaveLength(2);
  });

  it("returns nothing when no payment matches", () => {
    expect(matchingRecordedPayments([pay("a", 100)], 6372)).toEqual([]);
  });
});

describe("closedReportSummary", () => {
  const base = {
    targetKind: "invoice" as const,
    reportedAmount: 6372,
    reportedMode: "bank_transfer",
    reportedOn: "2026-10-01",
    modeLabel: (m: string) => ({ neft: "NEFT", bank_transfer: "Bank Transfer" }[m] ?? m),
  };

  it("points a verified invoice report at the payment it was linked to", () => {
    const r = closedReportSummary({
      ...base, status: "verified",
      linkedPayment: { payment_mode: "neft", payment_reference: "22317" },
    });
    expect(r.headline).toBe("Payment report closed");
    expect(r.linkLine).toBe("Linked to the payment recorded on the invoice (NEFT, ref 22317)");
  });

  it("says a deposit adjustment settled it rather than naming a bank mode", () => {
    const r = closedReportSummary({
      ...base, status: "verified",
      linkedPayment: { payment_mode: "deposit_adjustment", payment_reference: "9fc3e278-d441" },
    });
    expect(r.linkLine).toBe("Settled by deposit adjustment");
  });

  it("leaves the reference out when the payment has none", () => {
    const r = closedReportSummary({
      ...base, status: "verified",
      linkedPayment: { payment_mode: "neft", payment_reference: null },
    });
    expect(r.linkLine).toBe("Linked to the payment recorded on the invoice (NEFT)");
  });

  it("still reads sensibly if the linked payment cannot be loaded", () => {
    const r = closedReportSummary({ ...base, status: "verified", linkedPayment: null });
    expect(r.linkLine).toBe("Linked to the recorded payment");
  });

  it("describes a deposit report as recorded against the deposit", () => {
    const r = closedReportSummary({ ...base, targetKind: "deposit", status: "verified", linkedPayment: null });
    expect(r.linkLine).toBe("Recorded against the deposit");
  });

  it("says no such payment for a rejected report, with no link line", () => {
    const r = closedReportSummary({ ...base, status: "rejected", linkedPayment: null });
    expect(r.headline).toBe("Payment report closed — no such payment");
    expect(r.linkLine).toBeNull();
  });
});

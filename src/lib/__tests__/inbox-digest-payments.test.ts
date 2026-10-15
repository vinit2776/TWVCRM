import { describe, it, expect } from "vitest";
import {
  MAX_LISTED,
  renderPaymentsToVerifyHtml,
  sortOldestFirst,
  waitingDays,
  type PendingPaymentReport,
} from "../inbox-digest-payments";

const NOW = Date.parse("2026-10-15T04:00:00Z");
const DAY = 86_400_000;

function report(over: Partial<PendingPaymentReport> = {}): PendingPaymentReport {
  return {
    customer: "Acme Studio",
    reference: "BS-0571",
    amount: 59000,
    paymentMode: "upi",
    reportedBy: "Riya",
    createdAt: new Date(NOW - DAY).toISOString(),
    ...over,
  };
}

describe("waitingDays", () => {
  it("counts whole days and never goes negative", () => {
    expect(waitingDays(new Date(NOW - 3 * DAY - 1000).toISOString(), NOW)).toBe(3);
    expect(waitingDays(new Date(NOW + DAY).toISOString(), NOW)).toBe(0);
  });
});

describe("sortOldestFirst", () => {
  it("puts the longest-waiting claim first without mutating the input", () => {
    const a = report({ customer: "newer", createdAt: new Date(NOW - DAY).toISOString() });
    const b = report({ customer: "older", createdAt: new Date(NOW - 4 * DAY).toISOString() });
    const input = [a, b];
    expect(sortOldestFirst(input).map((r) => r.customer)).toEqual(["older", "newer"]);
    expect(input[0].customer).toBe("newer");
  });
});

describe("renderPaymentsToVerifyHtml", () => {
  it("renders nothing when there is nothing to verify", () => {
    expect(renderPaymentsToVerifyHtml([], "https://x.test", NOW)).toBe("");
  });

  it("shows the count, the customer and a link to the inbox", () => {
    const html = renderPaymentsToVerifyHtml([report()], "https://x.test", NOW);
    expect(html).toContain("Payments to verify (1)");
    expect(html).toContain("Acme Studio");
    expect(html).toContain("https://x.test/accounting/inbox");
  });

  it("caps the list and says how many were left out", () => {
    const many = Array.from({ length: MAX_LISTED + 3 }, (_, i) => report({ customer: `Cust ${i}` }));
    const html = renderPaymentsToVerifyHtml(many, "https://x.test", NOW);
    expect(html).toContain(`Payments to verify (${MAX_LISTED + 3})`);
    expect(html).toContain("+ 3 more");
  });

  it("escapes customer names so they can't inject markup", () => {
    const html = renderPaymentsToVerifyHtml(
      [report({ customer: "<script>alert(1)</script>" })],
      "https://x.test",
      NOW,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("flags claims waiting two days or more", () => {
    const html = renderPaymentsToVerifyHtml(
      [report({ createdAt: new Date(NOW - 2 * DAY).toISOString() })],
      "https://x.test",
      NOW,
    );
    expect(html).toContain("color:#a32d2d");
    expect(html).toContain("2 days");
  });
});

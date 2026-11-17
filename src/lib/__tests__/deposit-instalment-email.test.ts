import { describe, expect, it } from "vitest";
import { buildPartReceivedEmail, buildPartRequestEmail, receivedFigures, requestFigures } from "../deposit-instalment-email";

const base = { proposalNumber: "PROP-0005", customerName: "Asha <b>", required: 60000 };

describe("deposit part emails", () => {
  it("request: required, paid so far, this part and balance after add up", () => {
    const f = requestFigures({ ...base, seq: 2, amount: 20000, rows: [
      { amount: 20000, status: "paid", paid_amount: 20000 },
      { amount: 20000, status: "requested" },
    ] });
    expect(f).toMatchObject({ required: 60000, paidBefore: 20000, thisPart: 20000, balanceAfter: 20000, isFinal: false });
  });

  it("request: asking for the whole balance is the final part", () => {
    const f = requestFigures({ ...base, seq: 2, amount: 40000, rows: [
      { amount: 20000, status: "paid", paid_amount: 20000 },
      { amount: 40000, status: "requested" },
    ] });
    expect(f.balanceAfter).toBe(0);
    expect(f.isFinal).toBe(true);
  });

  it("received: counts this part as paid and shows what is left", () => {
    const f = receivedFigures({ ...base, seq: 1, amount: 20000, rows: [{ amount: 20000, status: "paid", paid_amount: 20000 }] });
    expect(f).toMatchObject({ paidBefore: 0, thisPart: 20000, balanceAfter: 40000, isFinal: false });
  });

  it("received: final part says the deposit is complete", () => {
    const { html, subject } = buildPartReceivedEmail({ ...base, seq: 3, amount: 20000, rows: [
      { amount: 20000, status: "paid", paid_amount: 20000 },
      { amount: 20000, status: "paid", paid_amount: 20000 },
      { amount: 20000, status: "paid", paid_amount: 20000 },
    ] });
    expect(html).toContain("deposit is now complete");
    expect(subject).toContain("Part 3");
  });

  it("request email carries all four lines, the pay link, and escapes the name", () => {
    const { html } = buildPartRequestEmail({ ...base, seq: 1, amount: 20000, rows: [{ amount: 20000, status: "requested" }], payLinkUrl: "https://rzp.io/x" });
    for (const t of ["Total security deposit", "Paid so far", "Requested now (Part 1)", "Balance after this payment", "₹60,000", "₹40,000", "https://rzp.io/x"]) {
      expect(html).toContain(t);
    }
    expect(html).not.toContain("Asha <b>");
  });
});

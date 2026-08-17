import { describe, it, expect } from "vitest";
import {
  rentStatementContractId,
  computeRenewalSplitRentSegments,
  type RenewalDraftPricing,
  type RatePhaseDetail,
} from "../billing";

// Modelled on the real case this logic was fixed for: TWV-C-0082 (parent,
// 2026-06-01 → 2026-07-20, ₹25,000/mo) renewed by TWV-C-0111 (2026-07-21 →
// 2027-06-20, ₹27,500/mo for 5 seats). The expected amounts below are the ones
// that actually appeared on the production statements — see the July case.
const PARENT = "parent-id";
const RENEWAL = "renewal-id";

const draft = (over: Partial<RenewalDraftPricing> = {}): RenewalDraftPricing => ({
  id: RENEWAL,
  start_date: "2026-07-21",
  end_date: "2027-06-20",
  total_amount: 32450,
  subtotal: 27500,
  tax_percentage: 18,
  phase_start_date: null,
  seats: 5,
  status: "accepted",
  billing_mode: "proforma_first",
  contract_number: "TWV-C-0111",
  ...over,
});

const noPhases = new Map<string, RatePhaseDetail[]>();

describe("rentStatementContractId", () => {
  it("files against the renewal when the parent's term ended before the month began", () => {
    // The August 2026 case: parent ended 2026-07-20, August is 100% renewal terms.
    expect(
      rentStatementContractId(PARENT, "2026-07-20", draft(), "2026-08-01", "2026-08-31")
    ).toBe(RENEWAL);
  });

  it("keeps a split month on the parent", () => {
    // July 2026: parent covers 1–20, renewal covers 21–31. One statement carries
    // one contract_id, and the PDF labels both segments.
    expect(
      rentStatementContractId(PARENT, "2026-07-20", draft(), "2026-07-01", "2026-07-31")
    ).toBe(PARENT);
  });

  it("keeps the month on the parent when its term ends exactly on day one", () => {
    expect(
      rentStatementContractId(PARENT, "2026-08-01", draft(), "2026-08-01", "2026-08-31")
    ).toBe(PARENT);
  });

  it("stays on the parent when there is no renewal at all", () => {
    expect(
      rentStatementContractId(PARENT, "2026-07-20", undefined, "2026-08-01", "2026-08-31")
    ).toBe(PARENT);
  });

  it("ignores an unsent draft renewal — not billable yet", () => {
    expect(
      rentStatementContractId(PARENT, "2026-07-20", draft({ status: "draft" }), "2026-08-01", "2026-08-31")
    ).toBe(PARENT);
  });

  it("ignores an already-active renewal — it bills under its own id, so redirecting would double-bill", () => {
    expect(
      rentStatementContractId(PARENT, "2026-07-20", draft({ status: "active" }), "2026-08-01", "2026-08-31")
    ).toBe(PARENT);
  });

  it("accepts a renewal that has been sent but not yet accepted", () => {
    expect(
      rentStatementContractId(PARENT, "2026-07-20", draft({ status: "sent" }), "2026-08-01", "2026-08-31")
    ).toBe(RENEWAL);
  });

  it("stays on the parent when the renewal has not started by month end", () => {
    expect(
      rentStatementContractId(PARENT, "2026-07-20", draft({ start_date: "2026-10-01" }), "2026-08-01", "2026-08-31")
    ).toBe(PARENT);
  });

  it("stays on the parent when the renewal term ended before the month began", () => {
    expect(
      rentStatementContractId(
        PARENT, "2026-06-30",
        draft({ start_date: "2026-07-01", end_date: "2026-07-31" }),
        "2026-08-01", "2026-08-31"
      )
    ).toBe(PARENT);
  });
});

describe("computeRenewalSplitRentSegments", () => {
  it("prices a fully-lapsed parent's month entirely at the renewal's rate", () => {
    // August 2026 — the statement that was mis-attributed. ₹27,500 = ₹5,500 × 5.
    const r = computeRenewalSplitRentSegments(
      PARENT, "2026-06-01", "2026-07-20", 25000, 29500, null, 18,
      draft(), noPhases, "2026-08-01", "2026-08-31", 31
    );
    expect(r.ownSegments).toHaveLength(0);
    expect(r.draftSegments).toHaveLength(1);
    expect(r.amount).toBe(27500);
    expect(r.isRenewalSplit).toBe(false);
    expect(r.taxPercentage).toBe(18);
  });

  it("splits the changeover month between both rates (matches production July 2026)", () => {
    // TWV-BS-0133 billed ₹16,129 for Jul 1–20 at the old rate; the renewal's
    // pro-rata for Jul 21–31 was ₹9,758.
    const r = computeRenewalSplitRentSegments(
      PARENT, "2026-06-01", "2026-07-20", 25000, 29500, null, 18,
      draft(), noPhases, "2026-07-01", "2026-07-31", 31
    );
    expect(r.isRenewalSplit).toBe(true);
    expect(r.ownSegments).toHaveLength(1);
    expect(r.ownSegments[0].days).toBe(20);
    expect(r.ownSegments[0].amount).toBe(16129);
    expect(r.draftSegments).toHaveLength(1);
    expect(r.draftSegments[0].days).toBe(11);
    expect(r.draftSegments[0].amount).toBe(9758);
    expect(r.amount).toBe(25887);
  });

  it("uses the parent's own terms for a whole month it still covers", () => {
    const r = computeRenewalSplitRentSegments(
      PARENT, "2026-06-01", "2026-07-20", 25000, 29500, null, 18,
      draft(), noPhases, "2026-06-01", "2026-06-30", 30
    );
    expect(r.draftSegments).toHaveLength(0);
    expect(r.amount).toBe(25000);
    expect(r.isRenewalSplit).toBe(false);
  });

  it("reduces to plain proration when there is no renewal", () => {
    const r = computeRenewalSplitRentSegments(
      PARENT, "2026-06-01", "2026-07-20", 25000, 29500, null, 18,
      undefined, noPhases, "2026-07-01", "2026-07-31", 31
    );
    expect(r.amount).toBe(16129);
    expect(r.isRenewalSplit).toBe(false);
  });

  it("leaves a genuine gap between the two terms unbilled rather than fabricating days", () => {
    // Parent ends Jul 20, renewal only starts Aug 10 — Aug 1–9 belongs to nobody.
    const r = computeRenewalSplitRentSegments(
      PARENT, "2026-06-01", "2026-07-20", 25000, 29500, null, 18,
      draft({ start_date: "2026-08-10" }), noPhases, "2026-08-01", "2026-08-31", 31
    );
    expect(r.draftSegments).toHaveLength(1);
    expect(r.draftSegments[0].start).toBe("2026-08-10");
    expect(r.draftSegments[0].days).toBe(22);
    // 27500 / 31 * 22 — the 9 uncovered days are not billed to anyone.
    expect(r.amount).toBe(19516);
  });

  it("never bills a day twice across the changeover", () => {
    const r = computeRenewalSplitRentSegments(
      PARENT, "2026-06-01", "2026-07-20", 25000, 29500, null, 18,
      // A renewal whose start_date overlaps the parent's last days.
      draft({ start_date: "2026-07-15" }), noPhases, "2026-07-01", "2026-07-31", 31
    );
    const totalDays = [...r.ownSegments, ...r.draftSegments].reduce((s, seg) => s + seg.days, 0);
    expect(totalDays).toBe(31);
    expect(r.draftSegments[0].start).toBe("2026-07-21");
  });

  it("takes the tax rate from whichever term covers most of the month", () => {
    // Renewal covers the whole month at 12% — its rate must win over the parent's 18%.
    const r = computeRenewalSplitRentSegments(
      PARENT, "2026-06-01", "2026-07-20", 25000, 29500, null, 18,
      draft({ tax_percentage: 12 }), noPhases, "2026-08-01", "2026-08-31", 31
    );
    expect(r.taxPercentage).toBe(12);
  });
});

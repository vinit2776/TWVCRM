import { describe, it, expect } from "vitest";
import {
  computeRenewalJourney,
  nextStepFor,
  needsRole,
  type RenewalJourneyInput,
} from "@/lib/vo-renewal-journey";

const base: RenewalJourneyInput = {
  today: "2026-12-01",
  caseStatus: "active",
  endDate: "2026-12-18",
  graceLastDay: null,
  purpose: "gst_registration",
  payer: { postpaid: false, blocked: null, hasEmail: true, hasPhone: true },
  openBill: null,
  notices: { count: 0 },
  openReport: null,
  partnerConfirmation: null,
  lapse: { latestDecision: null, draftDocuments: 0, documentsSent: false },
  successor: null,
};

const withBill: RenewalJourneyInput = {
  ...base,
  openBill: { statementNumber: "BS-0700", totalAmount: 59000, periodStart: "2026-12-19", periodEnd: "2027-12-18" },
};

const states = (j: ReturnType<typeof computeRenewalJourney>) => Object.fromEntries(j.steps.map((s) => [s.key, s.state]));

describe("computeRenewalJourney: direct client", () => {
  it("starts at Start renewal for a complete case with no bill", () => {
    const j = computeRenewalJourney(base);
    expect(j.stage).toBe("renewal");
    expect(j.nextStep?.key).toBe("start");
    expect(j.nextStep?.action).toBe("start_renewal");
    expect(states(j)).toMatchObject({ check: "done", start: "current", tell: "upcoming", pay: "upcoming", term: "upcoming" });
    expect(j.goal).toBe("New term starts 19 Dec 2026, paid and active before 18 Dec 2026");
    expect(j.daysLeft).toBe(17);
  });

  it("blocks on the case check and says what is missing", () => {
    const j = computeRenewalJourney({ ...base, payer: { postpaid: false, blocked: "Billing party not set.", hasEmail: false, hasPhone: false } });
    expect(j.nextStep?.key).toBe("check");
    expect(j.nextStep?.state).toBe("blocked");
    expect(j.nextStep?.hint).toContain("billing party not set");
    expect(states(j).start).toBe("upcoming");
  });

  it("asks for a contact when the payer has neither email nor phone", () => {
    const j = computeRenewalJourney({ ...base, payer: { postpaid: false, blocked: null, hasEmail: false, hasPhone: false } });
    expect(j.nextStep?.hint).toContain("email or phone");
  });

  it("waits on payment once a bill exists, even if no notice is logged", () => {
    const j = computeRenewalJourney(withBill);
    expect(states(j)).toMatchObject({ start: "done", tell: "optional", pay: "current" });
    expect(j.nextStep?.key).toBe("pay");
    expect(j.nextStep?.owner).toBe("payer");
    expect(j.goal).toBe("New term 19 Dec 2026 to 18 Dec 2027, paid and active before 18 Dec 2026");
  });

  it("marks Tell the payer done once a notice is logged", () => {
    const j = computeRenewalJourney({ ...withBill, notices: { count: 2 } });
    expect(states(j).tell).toBe("done");
    expect(j.steps.find((s) => s.key === "tell")?.detail).toBe("2 notices sent");
  });

  it("makes accounts the owner once a payment is reported", () => {
    const j = computeRenewalJourney({
      ...withBill,
      openReport: { amount: 59000, paidOn: "2026-12-12", reportedBy: "Asha" },
    });
    expect(j.nextStep?.key).toBe("verify");
    expect(j.nextStep?.owner).toBe("accounts");
    expect(j.nextStep?.detail).toBe("₹59,000 reported 12 Dec 2026 by Asha");
    expect(states(j).pay).toBe("done");
  });

  it("is complete once the case has a successor", () => {
    const j = computeRenewalJourney({
      ...withBill,
      caseStatus: "renewed",
      successor: { id: "c2", caseNumber: "TWV-VO-0200" },
    });
    expect(j.complete).toBe(true);
    expect(j.nextStep).toBeNull();
    expect(j.stage).toBe("renewed");
    expect(j.goal).toBe("Renewed as TWV-VO-0200");
    expect(j.steps.every((s) => s.state === "done")).toBe(true);
  });
});

describe("computeRenewalJourney: after the end date", () => {
  it("shows the grace window as information, not the next step", () => {
    const j = computeRenewalJourney({ ...withBill, today: "2026-12-20", graceLastDay: "2026-12-25" });
    expect(j.stage).toBe("grace");
    expect(j.nextStep?.key).toBe("pay");
    const grace = j.steps.find((s) => s.key === "grace");
    expect(grace?.state).toBe("optional");
    expect(grace?.detail).toBe("5 grace days left");
  });

  it("asks admin or manager to decide once lapsed", () => {
    const j = computeRenewalJourney({ ...withBill, today: "2027-01-05", caseStatus: "lapsed" });
    expect(j.stage).toBe("lapsed");
    expect(j.nextStep?.key).toBe("lapse");
    expect(j.nextStep?.roles).toEqual(["admin", "manager"]);
    expect(needsRole(j, "admin")).toBe(true);
    expect(needsRole(j, "sales_rep")).toBe(false);
  });

  it("moves to reviewing discontinuation drafts after that decision", () => {
    const j = computeRenewalJourney({
      ...base,
      today: "2027-01-05",
      caseStatus: "lapsed",
      lapse: { latestDecision: "discontinue", draftDocuments: 3, documentsSent: false },
    });
    expect(states(j)).toMatchObject({ lapse: "done", discontinue: "current", start: "optional" });
    const d = j.steps.find((s) => s.key === "discontinue");
    expect(d?.detail).toBe("3 drafts to review");
  });
});

describe("computeRenewalJourney: postpaid partner", () => {
  const partner: RenewalJourneyInput = { ...base, payer: { postpaid: true, blocked: null, hasEmail: false, hasPhone: false } };

  it("has no bill or payment steps and asks sales to confirm", () => {
    const j = computeRenewalJourney(partner);
    expect(j.branch).toBe("partner");
    expect(j.steps.map((s) => s.key)).toEqual(["check", "partner", "term"]);
    expect(j.nextStep?.key).toBe("partner");
    expect(j.goal).toBe("New term starts 19 Dec 2026, confirmed before 18 Dec 2026");
  });

  it("waits on the automatic roll once confirmed", () => {
    const j = computeRenewalJourney({ ...partner, partnerConfirmation: { termStart: "2026-12-19", newRate: 48000 } });
    expect(states(j)).toMatchObject({ partner: "done", term: "current" });
    expect(j.nextStep?.owner).toBe("system");
  });
});

describe("views by role", () => {
  it("shows the task to a role that can do it", () => {
    const j = computeRenewalJourney(base);
    const sales = nextStepFor(j, "sales_rep");
    expect(sales?.mine).toBe(true);
    expect(needsRole(j, "sales_rep")).toBe(true);
  });

  it("shows who it waits on to a role that cannot", () => {
    const j = computeRenewalJourney({ ...withBill, openReport: { amount: 59000, paidOn: "2026-12-12", reportedBy: null } });
    const sales = nextStepFor(j, "sales_rep");
    expect(sales?.mine).toBe(false);
    expect(sales?.waitingOn).toBe("Accounts");
    expect(needsRole(j, "sales_rep")).toBe(false);
    expect(needsRole(j, "accounts")).toBe(true);
  });

  it("never claims a payer or system step for anyone", () => {
    const j = computeRenewalJourney(withBill);
    expect(needsRole(j, "admin")).toBe(false);
    expect(nextStepFor(j, "admin")?.waitingOn).toBe("The payer");
  });

  it("handles a missing role", () => {
    expect(needsRole(computeRenewalJourney(base), null)).toBe(false);
  });
});

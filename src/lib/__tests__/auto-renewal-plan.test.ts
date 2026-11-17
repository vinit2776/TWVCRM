import { describe, it, expect } from "vitest";
import {
  PLAN_STAGE_LABELS,
  computeRollDate,
  digestSubject,
  escapeHtml,
  planAutoRenewals,
  previewNextRent,
  renderDigestHtml,
  type AutoRenewFacts,
} from "../auto-renewal-plan";

const RENT_AND_MAINTENANCE = [
  { description: "Open Desk rent", quantity: 1, unit_price: 13000, escalates: true },
  { description: "Maintenance (fixed)", quantity: 1, unit_price: 2000, escalates: false },
];

function facts(over: Partial<AutoRenewFacts> = {}): AutoRenewFacts {
  return {
    id: "c-1",
    contractNumber: "TWV-C-0100",
    customer: "Acme Design LLP",
    location: "Kilpauk",
    status: "active",
    endDate: "2026-11-30",
    noticePeriodMonths: 2,
    seats: 1,
    items: RENT_AND_MAINTENANCE,
    subtotal: 15000,
    agreementEscalationPercentage: 10,
    escalationPercentage: 10,
    renewalDeclined: false,
    hasLiveExit: false,
    overdueAmount: 0,
    hasActiveMoratorium: false,
    hasActiveRentWaiver: false,
    hasRatePhases: false,
    specialClauseStatus: null,
    escalationApprovalPending: false,
    renewalDraft: null,
    ...over,
  };
}

const stageOn = (today: string, over: Partial<AutoRenewFacts> = {}) =>
  planAutoRenewals([facts(over)], today).items[0].stage;

describe("computeRollDate", () => {
  it("rolls the day after a month-end term", () => {
    expect(computeRollDate("2026-11-30")).toBe("2026-12-01");
    expect(computeRollDate("2026-12-31")).toBe("2027-01-01");
    expect(computeRollDate("2028-02-29")).toBe("2028-03-01");
  });

  it("waits for the 1st of the next month when the term ends mid-month", () => {
    expect(computeRollDate("2026-11-15")).toBe("2026-12-01");
    expect(computeRollDate("2026-12-15")).toBe("2027-01-01");
    expect(computeRollDate("2026-11-01")).toBe("2026-12-01");
  });
});

describe("previewNextRent", () => {
  it("escalates the rent line and leaves the fixed maintenance line alone", () => {
    expect(previewNextRent(RENT_AND_MAINTENANCE, 10, 15000)).toBe(16300);
    expect(previewNextRent(RENT_AND_MAINTENANCE, 7, 15000)).toBe(15910);
    expect(previewNextRent(RENT_AND_MAINTENANCE, 0, 15000)).toBe(15000);
  });

  it("rounds each unit price to whole rupees, like the renewal route", () => {
    expect(previewNextRent([{ description: "x", quantity: 1, unit_price: 9999, escalates: true }], 10, 9999)).toBe(10999);
  });

  it("escalates the whole stored subtotal when a contract has no line items", () => {
    expect(previewNextRent([], 10, 15000)).toBe(16500);
    expect(previewNextRent([], 0, 15000)).toBe(15000);
  });
});

describe("planAutoRenewals: stages for a term ending 30 Nov 2026 with a 2-month notice period", () => {
  // Schedule: draft 16 Sep, notice 23 Sep, deadline 30 Sep, confirmation 15 Nov, roll 1 Dec.
  it.each([
    ["2026-08-01", "scheduled"],
    ["2026-09-15", "scheduled"],
    ["2026-09-16", "draft_due"],
    ["2026-09-22", "draft_due"],
    ["2026-09-23", "notice_window"],
    ["2026-09-30", "notice_window"],
    ["2026-10-01", "waiting"],
    ["2026-11-14", "waiting"],
    ["2026-11-15", "confirmation_due"],
    ["2026-11-30", "confirmation_due"],
    ["2026-12-01", "roll_due"],
  ] as const)("on %s the stage is %s", (today, stage) => {
    expect(stageOn(today)).toBe(stage);
  });

  it("a 0-month notice period has no confirmation step", () => {
    // notice 23 Nov, deadline 30 Nov; no confirmation (it would precede the notice)
    expect(stageOn("2026-11-20", { noticePeriodMonths: 0 })).toBe("draft_due");
    expect(stageOn("2026-11-25", { noticePeriodMonths: 0 })).toBe("notice_window");
  });

  it("uses the 2-month default when no notice period is recorded", () => {
    expect(stageOn("2026-09-23", { noticePeriodMonths: null })).toBe("notice_window");
  });
});

describe("planAutoRenewals: a term ending mid-month", () => {
  const mid = { endDate: "2026-11-15", noticePeriodMonths: 1 };

  it("sits in awaiting_roll after the end date until the 1st", () => {
    expect(stageOn("2026-11-16", mid)).toBe("awaiting_roll");
    expect(stageOn("2026-11-30", mid)).toBe("awaiting_roll");
    expect(stageOn("2026-12-01", mid)).toBe("roll_due");
  });

  it("does not list awaiting_roll as due or held", () => {
    const plan = planAutoRenewals([facts(mid)], "2026-11-20");
    expect(plan.dueNow).toHaveLength(0);
    expect(plan.held).toHaveLength(0);
  });
});

describe("planAutoRenewals: holds", () => {
  it("holds with the reason, whatever the date", () => {
    const plan = planAutoRenewals([facts({ overdueAmount: 24000 })], "2026-09-23");
    expect(plan.held).toHaveLength(1);
    expect(plan.held[0].stage).toBe("held");
    expect(plan.held[0].holds.map((h) => h.code)).toEqual(["overdue"]);
    expect(plan.dueNow).toHaveLength(0);
  });

  it.each([
    ["moratorium", { hasActiveMoratorium: true }],
    ["rent_waiver", { hasActiveRentWaiver: true }],
    ["rate_phases", { hasRatePhases: true }],
    ["exit_in_progress", { hasLiveExit: true }],
    ["renewal_declined", { renewalDeclined: true }],
    ["escalation_approval_pending", { escalationApprovalPending: true }],
    ["special_clause_unapproved", { specialClauseStatus: "pending_approval" }],
    ["special_clause_unapproved", { specialClauseStatus: "changes_requested" }],
  ] as const)("holds for %s", (code, patch) => {
    expect(planAutoRenewals([facts(patch)], "2026-10-01").held[0].holds.map((h) => h.code)).toContain(code);
  });

  it("an approved special clause is not a hold", () => {
    expect(planAutoRenewals([facts({ specialClauseStatus: "approved" })], "2026-10-01").held).toHaveLength(0);
  });
});

describe("planAutoRenewals: sections", () => {
  it("lists contracts acting now in dueNow and dated steps inside 30 days in upcoming", () => {
    const acting = facts({ id: "a", contractNumber: "TWV-C-0001", endDate: "2026-11-30" });
    const soon = facts({ id: "b", contractNumber: "TWV-C-0002", endDate: "2027-01-31", noticePeriodMonths: 1 });
    const far = facts({ id: "c", contractNumber: "TWV-C-0003", endDate: "2027-09-30" });
    // On 25 Sep, A is inside its notice window; C is a year out; B's first step is months away.
    const plan = planAutoRenewals([acting, soon, far], "2026-09-25");
    expect(plan.dueNow.map((i) => i.facts.id)).toEqual(["a"]);
    expect(plan.upcoming.map((i) => i.facts.id)).not.toContain("c");
    expect(plan.items).toHaveLength(3);
  });

  it("orders by end date", () => {
    const plan = planAutoRenewals(
      [facts({ id: "late", endDate: "2027-03-31" }), facts({ id: "early", endDate: "2026-11-30" })],
      "2026-08-01",
    );
    expect(plan.items.map((i) => i.facts.id)).toEqual(["early", "late"]);
  });

  it("quotes an existing draft's rent and says when it was negotiated", () => {
    const plan = planAutoRenewals(
      [facts({ renewalDraft: { subtotal: 15910, escalationPercentage: 7 } })],
      "2026-11-10",
    );
    const item = plan.items[0];
    expect(item.nextRent).toBe(15910);
    expect(item.nextRentPct).toBe(7);
    expect(item.nextRentIsDraft).toBe(true);
    expect(item.programmedPct).toBe(10);
    const html = renderDigestHtml(plan, { dryRun: true });
    expect(html).toContain("₹15,910");
    expect(html).toContain("negotiated, agreement is 10%");
  });

  it("an existing draft at the agreement's rate is called a draft, not a negotiation", () => {
    const plan = planAutoRenewals([facts({ renewalDraft: { subtotal: 16300, escalationPercentage: 10 } })], "2026-11-10");
    expect(plan.items[0].nextRentPct).toBe(10);
    const html = renderDigestHtml(plan, { dryRun: true });
    expect(html).toContain("draft, +10%");
    expect(html).not.toContain("negotiated");
  });

  it("previews a revised rate for the next term, and labels it nothing more than the rent at that rate", () => {
    const item = planAutoRenewals([facts({ revisedEscalationPercentage: 7 })], "2026-10-01").items[0];
    expect(item.programmedPct).toBe(10);
    expect(item.nextRentPct).toBe(7);
    expect(item.nextRent).toBe(15910);
    expect(item.nextRentIsDraft).toBe(false);
  });

  it("an existing draft still wins over a revised rate", () => {
    const item = planAutoRenewals(
      [facts({ revisedEscalationPercentage: 7, renewalDraft: { subtotal: 16300, escalationPercentage: 10 } })],
      "2026-11-10",
    ).items[0];
    expect(item.nextRent).toBe(16300);
    expect(item.nextRentPct).toBe(10);
  });

  it("carries the programmed escalation and the next rent for each contract", () => {
    const item = planAutoRenewals([facts({ agreementEscalationPercentage: 10, escalationPercentage: 7 })], "2026-10-01").items[0];
    expect(item.programmedPct).toBe(10);
    expect(item.nextRent).toBe(16300);
  });
});

describe("digest", () => {
  const plan = planAutoRenewals(
    [
      facts({ id: "held-1", contractNumber: "TWV-C-0007", customer: "K. Rao & Co", overdueAmount: 5000 }),
      facts({ id: "act-1", contractNumber: "TWV-C-0008", endDate: "2026-11-30" }),
    ],
    "2026-09-25",
  );

  it("escapes anything that came from the database", () => {
    const evil = planAutoRenewals([facts({ customer: '<img src=x onerror=alert(1)>', overdueAmount: 1 })], "2026-09-25");
    const html = renderDigestHtml(evil, { dryRun: true });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(escapeHtml(`a&b<c>"d"'e'`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;");
  });

  it("says it is a dry run and that nothing was sent", () => {
    const html = renderDigestHtml(plan, { dryRun: true });
    expect(html).toContain("Dry run");
    expect(html).toContain("no customer was contacted");
  });

  it("names the held contract with its reason and the acting contract with its next rent", () => {
    const html = renderDigestHtml(plan, { dryRun: true });
    expect(html).toContain("Needs a person (1)");
    expect(html).toContain("TWV-C-0007");
    expect(html).toContain("Overdue invoices");
    expect(html).toContain("Due now (1)");
    expect(html).toContain(PLAN_STAGE_LABELS.notice_window);
    expect(html).toContain("₹16,300");
  });

  it("links contracts when an app URL is given", () => {
    expect(renderDigestHtml(plan, { dryRun: true, appUrl: "https://twv-crm.vercel.app" })).toContain(
      "https://twv-crm.vercel.app/contracts/act-1",
    );
  });

  it("has a subject that says dry run and counts the sections", () => {
    expect(digestSubject(plan, true)).toBe("[Dry run] Auto-renewal: 2 on autopilot, 1 held, 1 due now · 2026-09-25");
    expect(digestSubject(plan, false)).toBe("Auto-renewal: 2 on autopilot, 1 held, 1 due now · 2026-09-25");
  });

  it("says so when there is nothing to report", () => {
    const quiet = planAutoRenewals([facts({ endDate: "2027-12-31" })], "2026-09-25");
    expect(renderDigestHtml(quiet, { dryRun: true })).toContain("Nothing needs attention");
  });
});

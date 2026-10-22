import { describe, expect, it } from "vitest";
import {
  classifyRenewalCase,
  dueReminderStage,
  parseCronMode,
  partnerRenewalIsCurrent,
  partnerRenewalOffer,
  partnerRenewalRecord,
  type CronCaseFacts,
} from "@/lib/vo-renewal-reminders";

const TODAY = "2026-11-10";
const NOW = "2026-11-10T04:00:00.000Z";

function facts(over: Partial<CronCaseFacts> = {}): CronCaseFacts {
  return {
    status: "renewal_due",
    end_date: "2026-11-30",
    renewal_notices_enabled: true,
    postpaid: false,
    renewal_reminder_count: 1,
    renewal_last_reminder_at: "2026-10-31T04:00:00.000Z",
    renewal_grace_ends_at: null,
    has_open_bill: true,
    partner_intent: null,
    lapse_decision: null,
    ...over,
  };
}

describe("parseCronMode", () => {
  it("falls back to dry_run, never live", () => {
    expect(parseCronMode(undefined)).toBe("dry_run");
    expect(parseCronMode("")).toBe("dry_run");
    expect(parseCronMode("LIVE")).toBe("dry_run");
    expect(parseCronMode("live")).toBe("live");
    expect(parseCronMode("off")).toBe("off");
  });
});

describe("dueReminderStage", () => {
  const base = { reminderCount: 1, lastReminderAt: "2026-10-01T00:00:00Z", today: TODAY };

  it("waits until a stage is due", () => {
    expect(dueReminderStage({ ...base, daysLeft: 22 })).toBeNull();
    expect(dueReminderStage({ ...base, daysLeft: 21 })).toBe(2);
  });

  it("catches up after missed days: a skipped day is not a skipped stage", () => {
    expect(dueReminderStage({ ...base, daysLeft: 19 })).toBe(2);
    expect(dueReminderStage({ ...base, daysLeft: 18, reminderCount: 2 })).toBeNull();
  });

  it("sends only the latest due stage when several were missed", () => {
    expect(dueReminderStage({ ...base, daysLeft: 10 })).toBe(3);
    expect(dueReminderStage({ ...base, daysLeft: 5 })).toBe(4);
  });

  it("never repeats a stage", () => {
    expect(dueReminderStage({ ...base, daysLeft: 6, reminderCount: 4 })).toBeNull();
  });

  it("does nothing when no first notice was sent", () => {
    expect(dueReminderStage({ ...base, daysLeft: 14, reminderCount: 0 })).toBeNull();
  });

  it("does nothing on or after the end date (expiry has its own step)", () => {
    expect(dueReminderStage({ ...base, daysLeft: 0 })).toBeNull();
    expect(dueReminderStage({ ...base, daysLeft: -3 })).toBeNull();
  });

  it("keeps a minimum gap from the previous notice", () => {
    expect(dueReminderStage({ ...base, daysLeft: 14, lastReminderAt: "2026-11-09T04:00:00Z" })).toBeNull();
    expect(dueReminderStage({ ...base, daysLeft: 14, lastReminderAt: "2026-11-07T04:00:00Z" })).toBe(3);
  });
});

describe("classifyRenewalCase", () => {
  it("ignores cases that are not opted in", () => {
    expect(classifyRenewalCase(facts({ renewal_notices_enabled: false, end_date: "2026-11-12" }), TODAY, NOW)).toEqual({ kind: "none" });
  });

  it("ignores cases without an end date or in other statuses", () => {
    expect(classifyRenewalCase(facts({ end_date: null }), TODAY, NOW)).toEqual({ kind: "none" });
    expect(classifyRenewalCase(facts({ status: "lapsed" }), TODAY, NOW)).toEqual({ kind: "none" });
    expect(classifyRenewalCase(facts({ status: "renewed" }), TODAY, NOW)).toEqual({ kind: "none" });
  });

  it("never opens a renewal: an active case is only flagged for a person", () => {
    expect(classifyRenewalCase(facts({ status: "active", end_date: "2026-12-20", renewal_reminder_count: 0, has_open_bill: false }), TODAY, NOW))
      .toEqual({ kind: "attention", reason: "not_started" });
    expect(classifyRenewalCase(facts({ status: "active", end_date: "2027-03-01", renewal_reminder_count: 0, has_open_bill: false }), TODAY, NOW))
      .toEqual({ kind: "none" });
    expect(classifyRenewalCase(facts({ status: "active", end_date: "2026-11-01", renewal_reminder_count: 0, has_open_bill: false }), TODAY, NOW))
      .toEqual({ kind: "attention", reason: "never_notified" });
  });

  it("sends the next reminder on a due, notified renewal", () => {
    expect(classifyRenewalCase(facts({ end_date: "2026-11-24" }), TODAY, NOW)).toEqual({ kind: "reminder", stage: 3 });
  });

  it("sends the final notice at expiry only if the customer was told", () => {
    expect(classifyRenewalCase(facts({ end_date: "2026-11-10" }), TODAY, NOW)).toEqual({ kind: "final_notice" });
    expect(classifyRenewalCase(facts({ end_date: "2026-11-10", renewal_reminder_count: 0 }), TODAY, NOW))
      .toEqual({ kind: "attention", reason: "never_notified" });
  });

  it("flags a renewal marked due with no bill to chase", () => {
    expect(classifyRenewalCase(facts({ has_open_bill: false }), TODAY, NOW)).toEqual({ kind: "attention", reason: "no_bill_or_link" });
  });

  it("lapses only after the grace date, and not while someone has recorded the client as paid", () => {
    const grace = facts({ status: "grace_period", end_date: "2026-11-01", renewal_grace_ends_at: "2026-11-09T00:00:00Z" });
    expect(classifyRenewalCase(grace, TODAY, NOW)).toEqual({ kind: "lapse" });
    expect(classifyRenewalCase({ ...grace, renewal_grace_ends_at: "2026-11-12T00:00:00Z" }, TODAY, NOW)).toEqual({ kind: "none" });
    expect(classifyRenewalCase({ ...grace, lapse_decision: "paid" }, TODAY, NOW)).toEqual({ kind: "attention", reason: "lapse_blocked" });
    expect(classifyRenewalCase({ ...grace, lapse_decision: "more_time", renewal_grace_ends_at: "2026-11-15T00:00:00Z" }, TODAY, NOW)).toEqual({ kind: "none" });
  });

  describe("postpaid partner cases", () => {
    const partner = (over: Partial<CronCaseFacts> = {}) =>
      facts({ postpaid: true, status: "active", has_open_bill: false, renewal_reminder_count: 0, ...over });

    it("are never reminded, graced or lapsed — only flagged", () => {
      expect(classifyRenewalCase(partner({ end_date: "2026-11-20" }), TODAY, NOW)).toEqual({ kind: "attention", reason: "partner_unconfirmed" });
      expect(classifyRenewalCase(partner({ end_date: "2026-11-01" }), TODAY, NOW)).toEqual({ kind: "attention", reason: "partner_unconfirmed" });
      expect(classifyRenewalCase(partner({ end_date: "2027-03-01" }), TODAY, NOW)).toEqual({ kind: "none" });
      expect(classifyRenewalCase(partner({ status: "grace_period", end_date: "2026-11-01", renewal_grace_ends_at: "2026-11-05T00:00:00Z" }), TODAY, NOW))
        .toEqual({ kind: "attention", reason: "partner_unconfirmed" });
    });

    it("roll over once the confirmed term has started, not before", () => {
      const intent = { term_start: "2026-11-21", term_end: "2027-11-20" };
      expect(classifyRenewalCase(partner({ end_date: "2026-11-20", partner_intent: intent }), "2026-11-20", NOW)).toEqual({ kind: "none" });
      expect(classifyRenewalCase(partner({ end_date: "2026-11-20", partner_intent: intent }), "2026-11-21", NOW)).toEqual({ kind: "partner_roll" });
      expect(classifyRenewalCase(partner({ end_date: "2026-11-20", partner_intent: intent }), "2026-11-25", NOW)).toEqual({ kind: "partner_roll" });
    });
  });
});

describe("partnerRenewalOffer", () => {
  const input = { currentMonthlyRate: 2500, agreedEscalationPercentage: 5, currentEnd: "2026-11-30", durationMonths: 12 };

  it("escalates the monthly rate and sets the next term", () => {
    const o = partnerRenewalOffer({ ...input, mode: "agreed" });
    expect(o.newRate).toBe(2625);
    expect(o.term).toEqual({ start: "2026-12-01", end: "2027-11-30" });
  });

  it("does not scale the monthly rate by duration", () => {
    expect(partnerRenewalOffer({ ...input, mode: "none", durationMonths: 6 }).newRate).toBe(2500);
  });

  it("applies a custom percentage and rounds to whole rupees", () => {
    expect(partnerRenewalOffer({ ...input, mode: "custom", customPercentage: 3.3 }).newRate).toBe(2583);
  });
});

describe("partner renewal record", () => {
  it("reads a stored confirmation and ignores junk", () => {
    expect(partnerRenewalRecord(null)).toBeNull();
    expect(partnerRenewalRecord({ partner_renewal: { term_start: "x" } })).toBeNull();
    const rec = { term_start: "2026-12-01", term_end: "2027-11-30", new_rate: 2625 };
    expect(partnerRenewalRecord({ partner_renewal: rec })?.new_rate).toBe(2625);
  });

  it("is current only while the case still ends the day before the term starts", () => {
    expect(partnerRenewalIsCurrent({ term_start: "2026-12-01", term_end: "2027-11-30" }, "2026-11-30")).toBe(true);
    expect(partnerRenewalIsCurrent({ term_start: "2026-12-01", term_end: "2027-11-30" }, "2026-12-10")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  renewalDeskTab,
  relativeEnd,
  daysUntil,
  graceLastDay,
  graceEndsAtFor,
  parseGraceDays,
} from "@/lib/vo-renewal-desk";

const TODAY = "2026-10-20";

describe("renewalDeskTab", () => {
  it("puts an active case ending inside 60 days in Coming up", () => {
    expect(renewalDeskTab({ status: "active", end_date: "2026-12-18" }, TODAY, false)).toBe("coming");
  });

  it("leaves an active case ending later off the desk", () => {
    expect(renewalDeskTab({ status: "active", end_date: "2027-03-01" }, TODAY, false)).toBeNull();
  });

  it("moves a case with an open renewal bill to Renewal due", () => {
    expect(renewalDeskTab({ status: "active", end_date: "2026-11-14" }, TODAY, true)).toBe("due");
    expect(renewalDeskTab({ status: "renewal_due", end_date: "2026-11-14" }, TODAY, false)).toBe("due");
  });

  it("treats an active case past its end as In grace, even though the cron never moved it", () => {
    expect(renewalDeskTab({ status: "active", end_date: "2026-10-16" }, TODAY, false)).toBe("grace");
    expect(renewalDeskTab({ status: "renewal_due", end_date: "2026-10-16" }, TODAY, true)).toBe("grace");
  });

  it("treats a case more than 7 days past its end as Lapsed", () => {
    expect(renewalDeskTab({ status: "active", end_date: "2026-10-12" }, TODAY, false)).toBe("lapsed");
    expect(renewalDeskTab({ status: "grace_period", end_date: "2026-10-01" }, TODAY, false)).toBe("lapsed");
  });

  it("keeps a lapsed case on the desk whatever its date", () => {
    expect(renewalDeskTab({ status: "lapsed", end_date: null }, TODAY, false)).toBe("lapsed");
  });

  it("ignores cases that are not live or were already renewed", () => {
    expect(renewalDeskTab({ status: "renewed", end_date: "2026-11-01" }, TODAY, false)).toBeNull();
    expect(renewalDeskTab({ status: "intake_received", end_date: "2026-11-01" }, TODAY, false)).toBeNull();
    expect(renewalDeskTab({ status: "active", end_date: null }, TODAY, false)).toBeNull();
  });
});

describe("grace length", () => {
  it("reads the setting, falling back to 7 days", () => {
    expect(parseGraceDays("10")).toBe(10);
    expect(parseGraceDays(null)).toBe(7);
    expect(parseGraceDays("0")).toBe(7);
    expect(parseGraceDays("31")).toBe(7);
    expect(parseGraceDays("2.5")).toBe(7);
  });

  it("uses the configured grace instead of 7 days", () => {
    // Ended 10 days ago: lapsed under 7 days, still in grace under 14.
    expect(renewalDeskTab({ status: "active", end_date: "2026-10-10" }, TODAY, false, 7)).toBe("lapsed");
    expect(renewalDeskTab({ status: "active", end_date: "2026-10-10" }, TODAY, false, 14)).toBe("grace");
  });

  it("keeps the last grace day in grace and lapses the day after", () => {
    expect(renewalDeskTab({ status: "active", end_date: "2026-10-13" }, TODAY, false, 7)).toBe("grace");
    expect(renewalDeskTab({ status: "active", end_date: "2026-10-12" }, TODAY, false, 7)).toBe("lapsed");
  });

  it("honours a grace end someone moved with Give more time", () => {
    const c = { status: "grace_period", end_date: "2026-09-30", renewal_grace_ends_at: graceEndsAtFor("2026-10-25") };
    expect(graceLastDay(c, 7)).toBe("2026-10-25");
    expect(renewalDeskTab(c, TODAY, false, 7)).toBe("grace");
    expect(renewalDeskTab(c, "2026-10-25", false, 7)).toBe("grace");
    expect(renewalDeskTab(c, "2026-10-26", false, 7)).toBe("lapsed");
  });

  it("reads a grace end the cron set (UTC midnight of the lapse day) the same way", () => {
    const c = { status: "grace_period", end_date: "2026-10-15", renewal_grace_ends_at: new Date("2026-10-22").toISOString() };
    expect(graceLastDay(c, 7)).toBe("2026-10-21");
    expect(renewalDeskTab(c, "2026-10-21", false, 7)).toBe("grace");
    expect(renewalDeskTab(c, "2026-10-22", false, 7)).toBe("lapsed");
  });

  it("stores the lapse moment as IST midnight after the last grace day", () => {
    expect(graceEndsAtFor("2026-10-25")).toBe("2026-10-25T18:30:00.000Z");
  });
});

describe("relativeEnd / daysUntil", () => {
  it("counts calendar days", () => {
    expect(daysUntil("2026-10-21", TODAY)).toBe(1);
    expect(daysUntil("2026-10-15", TODAY)).toBe(-5);
  });
  it("reads naturally", () => {
    expect(relativeEnd(0)).toBe("ends today");
    expect(relativeEnd(1)).toBe("in 1 day");
    expect(relativeEnd(-3)).toBe("ended 3 days ago");
  });
});

import { renewalBoardTab, needsAction, noticeSchedule } from "@/lib/vo-renewal-desk";

describe("renewalBoardTab", () => {
  it("shows a live case ending beyond the window as Active", () => {
    expect(renewalBoardTab({ status: "active", end_date: "2027-06-01" }, TODAY, false)).toBe("active");
    expect(renewalBoardTab({ status: "active", end_date: "2026-12-18" }, TODAY, false)).toBe("coming");
  });
  it("shows recently renewed cases and drops old ones", () => {
    expect(renewalBoardTab({ status: "renewed", end_date: "2026-10-01", renewed_at: "2026-10-10T05:00:00Z" }, TODAY, false)).toBe("renewed");
    expect(renewalBoardTab({ status: "renewed", end_date: "2026-01-01", renewed_at: "2026-01-10T05:00:00Z" }, TODAY, false)).toBeNull();
    expect(renewalBoardTab({ status: "renewed", end_date: "2026-10-01" }, TODAY, false)).toBeNull();
  });
  it("leaves other statuses off", () => {
    expect(renewalBoardTab({ status: "cancelled", end_date: "2027-06-01" }, TODAY, false)).toBeNull();
  });
});

describe("needsAction", () => {
  const base = { days_left: 10, postpaid: false, partner_confirmed: false, reminder_count: 0, lapse_decision: null as string | null };
  it("flags a due case with no first notice, not one already notified", () => {
    expect(needsAction({ ...base, tab: "due" })).toBe(true);
    expect(needsAction({ ...base, tab: "due", reminder_count: 2 })).toBe(false);
  });
  it("flags a coming case only once the first notice is due", () => {
    expect(needsAction({ ...base, tab: "coming", days_left: 45 })).toBe(false);
    expect(needsAction({ ...base, tab: "coming", days_left: 30 })).toBe(true);
  });
  it("flags grace, and lapsed without a decision", () => {
    expect(needsAction({ ...base, tab: "grace", reminder_count: 5 })).toBe(true);
    expect(needsAction({ ...base, tab: "lapsed" })).toBe(true);
    expect(needsAction({ ...base, tab: "lapsed", lapse_decision: "discontinue" })).toBe(false);
  });
  it("flags a postpaid partner until confirmed", () => {
    expect(needsAction({ ...base, tab: "coming", postpaid: true })).toBe(true);
    expect(needsAction({ ...base, tab: "coming", postpaid: true, partner_confirmed: true })).toBe(false);
  });
  it("never flags Active or Renewed", () => {
    expect(needsAction({ ...base, tab: "active" })).toBe(false);
    expect(needsAction({ ...base, tab: "renewed" })).toBe(false);
  });
});

describe("noticeSchedule", () => {
  const sent = (n: number, at: string) => ({ reminder_number: n, sent_at: at, email_sent: true, whatsapp_sent: n === 1 });
  it("lays out the five notices from the end date", () => {
    const s = noticeSchedule({ end_date: "2026-12-18" }, [], TODAY);
    expect(s.map((e) => e.due_date)).toEqual(["2026-11-18", "2026-11-27", "2026-12-04", "2026-12-11", "2026-12-18"]);
    expect(s.every((e) => e.status === "pending")).toBe(true);
    expect(s[4].label).toBe("Final notice");
  });
  it("marks sent notices with channels and flags overdue pending ones", () => {
    const s = noticeSchedule({ end_date: "2026-11-05" }, [sent(1, "2026-10-12T04:00:00Z")], TODAY);
    expect(s[0]).toMatchObject({ status: "sent", channels: ["Email", "WhatsApp"], overdue: false });
    expect(s[1]).toMatchObject({ status: "pending", overdue: true });
    expect(s[3]).toMatchObject({ status: "pending", overdue: false });
  });
  it("does not count a log row that reached no channel as sent", () => {
    const s = noticeSchedule({ end_date: "2026-12-18" }, [{ reminder_number: 1, sent_at: "2026-10-01T00:00:00Z", email_sent: false, whatsapp_sent: false }], TODAY);
    expect(s[0].status).toBe("pending");
  });
  it("is empty without an end date", () => {
    expect(noticeSchedule({ end_date: null }, [], TODAY)).toEqual([]);
  });
});

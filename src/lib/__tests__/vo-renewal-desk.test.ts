import { describe, it, expect } from "vitest";
import { renewalDeskTab, relativeEnd, daysUntil } from "@/lib/vo-renewal-desk";

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

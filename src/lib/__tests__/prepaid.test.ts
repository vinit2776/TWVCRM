import { describe, it, expect } from "vitest";
import { isPrepaidApplicableToSpace, isPrepaidOwnedByCustomer, escapeLike } from "../prepaid";

describe("isPrepaidApplicableToSpace", () => {
  const meeting = { id: "s1", workspace_type: "meeting_room" };

  it("accepts a package for the matching space type", () => {
    expect(isPrepaidApplicableToSpace({ workspace_type: "meeting_room" }, meeting)).toBe(true);
  });
  it("rejects a package for a different space type", () => {
    expect(isPrepaidApplicableToSpace({ workspace_type: "day_pass" }, meeting)).toBe(false);
  });
  it("rejects a package bound to another space", () => {
    expect(isPrepaidApplicableToSpace({ space_id: "s2" }, meeting)).toBe(false);
  });
  it("accepts a package bound to this space", () => {
    expect(isPrepaidApplicableToSpace({ space_id: "s1", workspace_type: "meeting_room" }, meeting)).toBe(true);
  });
  it("treats a legacy unrestricted package as applicable", () => {
    expect(isPrepaidApplicableToSpace({}, meeting)).toBe(true);
  });
});

describe("isPrepaidOwnedByCustomer", () => {
  it("matches the lead that bought the package", () => {
    expect(isPrepaidOwnedByCustomer({ lead_id: "l1" }, { leadId: "l1" })).toBe(true);
  });
  it("does not let another lead use a personal package", () => {
    expect(isPrepaidOwnedByCustomer({ lead_id: "l1" }, { leadId: "l2", company: "Zenith Labs" })).toBe(false);
  });
  it("lets any contact of the company use a company package, ignoring case and spacing", () => {
    expect(isPrepaidOwnedByCustomer({ company_name: "Zenith Labs" }, { leadId: "l9", company: "  zenith labs " })).toBe(true);
  });
  it("rejects a different company", () => {
    expect(isPrepaidOwnedByCustomer({ company_name: "Zenith Labs" }, { leadId: "l9", company: "Other Co" })).toBe(false);
  });
  it("rejects when the customer has no company", () => {
    expect(isPrepaidOwnedByCustomer({ company_name: "Zenith Labs" }, { leadId: "l9" })).toBe(false);
  });
});

describe("escapeLike", () => {
  it("escapes wildcards so names match literally", () => {
    expect(escapeLike("50%_off\\co")).toBe("50\\%\\_off\\\\co");
  });
});

import { decidePrepaidRestore, hoursBeforeStart, istDateString, addDaysToDate, isPrepaidValidAtLocation } from "../prepaid";

describe("decidePrepaidRestore", () => {
  it("restores when cancelled well before the window", () => {
    expect(decidePrepaidRestore({ trigger: "cancel", hoursBeforeStart: 5, windowHours: 2 }).restore).toBe(true);
  });
  it("restores exactly on the limit", () => {
    expect(decidePrepaidRestore({ trigger: "cancel", hoursBeforeStart: 2, windowHours: 2 }).restore).toBe(true);
  });
  it("forfeits inside the window", () => {
    expect(decidePrepaidRestore({ trigger: "cancel", hoursBeforeStart: 1.5, windowHours: 2 }).restore).toBe(false);
  });
  it("forfeits a no-show whatever the window", () => {
    expect(decidePrepaidRestore({ trigger: "no_show", hoursBeforeStart: -1, windowHours: 0 }).restore).toBe(false);
  });
  it("never restores when the package has no window", () => {
    expect(decidePrepaidRestore({ trigger: "cancel", hoursBeforeStart: 48, windowHours: null }).restore).toBe(false);
  });
  it("a zero window restores until the start time", () => {
    expect(decidePrepaidRestore({ trigger: "cancel", hoursBeforeStart: 0, windowHours: 0 }).restore).toBe(true);
    expect(decidePrepaidRestore({ trigger: "cancel", hoursBeforeStart: -0.5, windowHours: 0 }).restore).toBe(false);
  });
});

describe("hoursBeforeStart", () => {
  it("measures from the IST start time", () => {
    const now = new Date("2026-11-20T03:30:00Z"); // 09:00 IST
    expect(hoursBeforeStart("2026-11-20", "14:00:00", now)).toBe(5);
    expect(hoursBeforeStart("2026-11-20", "10:30", now)).toBe(1.5);
  });
  it("is negative after the start", () => {
    expect(hoursBeforeStart("2026-11-20", "08:00", new Date("2026-11-20T03:30:00Z"))).toBe(-1);
  });
});

describe("date helpers", () => {
  it("uses the IST calendar date, not UTC", () => {
    expect(istDateString(new Date("2026-11-20T20:00:00Z"))).toBe("2026-11-21");
  });
  it("adds days across a month end", () => {
    expect(addDaysToDate("2026-11-20", 30)).toBe("2026-12-20");
    expect(addDaysToDate("2026-01-31", 1)).toBe("2026-02-01");
  });
});

describe("isPrepaidValidAtLocation", () => {
  it("is valid everywhere when no locations were recorded", () => {
    expect(isPrepaidValidAtLocation([], "loc1")).toBe(true);
  });
  it("accepts a listed location and rejects others", () => {
    expect(isPrepaidValidAtLocation(["loc1", "loc2"], "loc2")).toBe(true);
    expect(isPrepaidValidAtLocation(["loc1"], "loc3")).toBe(false);
  });
  it("rejects a booking with no location when the package is restricted", () => {
    expect(isPrepaidValidAtLocation(["loc1"], null)).toBe(false);
  });
});

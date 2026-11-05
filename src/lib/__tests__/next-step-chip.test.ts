import { describe, it, expect } from "vitest";
import { nextStepChip } from "../next-step-chip";

// 5 Nov 2026, 12:00 IST
const NOW = new Date("2026-11-05T06:30:00Z");
// A time on the given IST day, 4:00 pm IST.
const at = (istDay: string) => `${istDay}T10:30:00Z`;

describe("nextStepChip", () => {
  it("counts days overdue and says which day it was due", () => {
    expect(nextStepChip(at("2026-10-16"), NOW)).toEqual({ state: "overdue", big: "20 days overdue", when: "was Fri 16 Oct" });
    expect(nextStepChip(at("2026-11-04"), NOW)).toMatchObject({ state: "overdue", big: "1 day overdue" });
  });

  it("shows only the time when it is due today, even if that time has passed", () => {
    expect(nextStepChip(at("2026-11-05"), NOW)).toEqual({ state: "today", big: "Today", when: "4:00 pm" });
    expect(nextStepChip("2026-11-05T02:30:00Z", NOW)).toMatchObject({ state: "today", when: "8:00 am" });
  });

  it("counts the days ahead, with the exact date and time beside it", () => {
    expect(nextStepChip(at("2026-11-06"), NOW)).toEqual({ state: "soon", big: "in 1 day", when: "Fri 6 Nov, 4:00 pm" });
    expect(nextStepChip(at("2026-12-05"), NOW)).toMatchObject({ state: "soon", big: "in 30 days" });
  });

  it("leads with the date once it is more than 30 days away", () => {
    expect(nextStepChip(at("2026-12-14"), NOW)).toEqual({ state: "far", big: "Mon 14 Dec", when: "in about 6 weeks" });
    expect(nextStepChip(at("2026-12-06"), NOW)).toMatchObject({ state: "far" });
  });

  it("judges the day in IST, not UTC", () => {
    // 11:30 pm IST on 5 Nov is still 5 Nov, though it is 6:00 pm UTC.
    expect(nextStepChip("2026-11-05T18:00:00Z", NOW).state).toBe("today");
    // 12:30 am IST on 6 Nov is 6 Nov, though it is still 5 Nov in UTC.
    expect(nextStepChip("2026-11-05T19:00:00Z", NOW).state).toBe("soon");
  });
});

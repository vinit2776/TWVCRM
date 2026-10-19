import { describe, it, expect } from "vitest";
import { followUpInputValue, followUpState } from "../enquiries";

// Follow-up dates are calendar days in IST, stored as that day's midnight (+05:30).
const NOW = new Date("2026-10-20T05:00:00Z"); // 10:30 IST on 20 Oct

describe("followUpState", () => {
  it("is null when there is no follow-up", () => {
    expect(followUpState(null, NOW)).toBeNull();
  });
  it("is overdue for a past day, today for the same IST day, upcoming after", () => {
    expect(followUpState("2026-10-19T00:00:00+05:30", NOW)).toBe("overdue");
    expect(followUpState("2026-10-20T00:00:00+05:30", NOW)).toBe("today");
    expect(followUpState("2026-10-21T00:00:00+05:30", NOW)).toBe("upcoming");
  });
  it("counts the IST day, not the UTC day, late in the evening", () => {
    // 23:30 IST on 20 Oct is still the 20th in IST although it is 18:00Z.
    expect(followUpState("2026-10-20T00:00:00+05:30", new Date("2026-10-20T18:00:00Z"))).toBe("today");
  });
});

describe("followUpInputValue", () => {
  it("round-trips the date the server stores", () => {
    expect(followUpInputValue("2026-10-20T00:00:00+05:30")).toBe("2026-10-20");
    expect(followUpInputValue(null)).toBe("");
  });
});

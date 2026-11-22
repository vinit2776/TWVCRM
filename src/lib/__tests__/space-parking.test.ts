import { describe, it, expect } from "vitest";
import { daysWaiting, parkProblem, releaseProblem, waitingGroupLabel } from "../space-parking";

const NOW = new Date("2026-11-22T06:00:00Z");
const ok = { locationId: "loc", otherArea: null, reason: "not_open", note: "Wants 4 seats near Anna Nagar", lookAgainOn: null };

describe("parkProblem", () => {
  it("accepts a complete request", () => expect(parkProblem(ok, NOW)).toBeNull());
  it("needs a centre or an area", () => {
    expect(parkProblem({ ...ok, locationId: null }, NOW)).toContain("where they want space");
    expect(parkProblem({ ...ok, locationId: null, otherArea: "OMR" }, NOW)).toBeNull();
  });
  it("needs a reason and a note", () => {
    expect(parkProblem({ ...ok, reason: "meh" }, NOW)).toBe("Pick why we cannot offer it yet");
    expect(parkProblem({ ...ok, note: " " }, NOW)).toBe("Add a note about what they want");
  });
  it("checks seats and the look-again date", () => {
    expect(parkProblem({ ...ok, seatsNeeded: 0 }, NOW)).toBe("Seats must be a whole number");
    expect(parkProblem({ ...ok, lookAgainOn: "2026-11-22" }, NOW)).toBe("Pick a look-again date after today");
    expect(parkProblem({ ...ok, lookAgainOn: "2026-12-15" }, NOW)).toBeNull();
    expect(parkProblem({ ...ok, lookAgainOn: "soon" }, NOW)).toBe("That look-again date is not valid");
  });
});

describe("releaseProblem", () => {
  it("needs a next step and a date that is not past", () => {
    expect(releaseProblem({ nextStep: "", followUpDate: "2026-11-25T10:00:00Z" }, NOW)).toBe("Say what the next step is");
    expect(releaseProblem({ nextStep: "Call about cabin", followUpDate: null }, NOW)).toBe("Pick when to do it");
    expect(releaseProblem({ nextStep: "Call", followUpDate: "2026-11-20T10:00:00Z" }, NOW)).toBe("Pick today or a later date");
    expect(releaseProblem({ nextStep: "Call", followUpDate: "2026-11-25T10:00:00Z" }, NOW)).toBeNull();
  });
});

describe("daysWaiting and waitingGroupLabel", () => {
  it("counts IST days", () => expect(daysWaiting("2026-11-12T06:00:00Z", NOW)).toBe(10));
  it("labels the group by centre or area and why", () => {
    expect(waitingGroupLabel({ locationName: null, otherArea: "Anna Nagar", reason: "not_open" })).toBe("Anna Nagar (not open)");
    expect(waitingGroupLabel({ locationName: "Perungudi", otherArea: null, reason: "no_space_of_size" })).toBe("Perungudi: no space of this size");
    expect(waitingGroupLabel({ locationName: "Perungudi", otherArea: null, reason: "other" })).toBe("Perungudi");
  });
});

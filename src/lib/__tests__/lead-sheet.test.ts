import { describe, it, expect } from "vitest";
import {
  sheetStatus,
  sheetLastAction,
  groupByDay,
  startsFolded,
  dayHeading,
  waitingText,
  passesSheetFilters,
  istDay,
  standardActionLabel,
  sheetSeats,
  flagTooltip,
  type SheetLeadInput,
} from "../lead-sheet";

const lead = (over: Partial<SheetLeadInput> = {}): SheetLeadInput => ({
  status: "new",
  created_at: "2026-11-24T05:00:00Z",
  assigned_user: { full_name: "Priya" },
  _last_contact: null,
  ...over,
});
const call = (subject: string, by: string | null = "Vignesh") => ({ subject, at: "2026-11-24T06:00:00Z", note: null, by });

describe("sheetStatus", () => {
  it("is not attended when nobody has acted on a new lead", () => {
    expect(sheetStatus(lead())).toBe("none");
  });
  it("follows the last thing a person logged", () => {
    expect(sheetStatus(lead({ status: "contacted", _last_contact: call("Spoke") }))).toBe("spoke");
    expect(sheetStatus(lead({ status: "contacted", _last_contact: call("No answer") }))).toBe("noanswer");
    expect(sheetStatus(lead({ status: "tour_scheduled", _last_contact: call("Tour booked") }))).toBe("tour");
    expect(sheetStatus(lead({ status: "contacted", _last_contact: call("Quote sent") }))).toBe("quote");
  });
  it("lets a sent proposal and the closed outcomes win over an older call", () => {
    expect(sheetStatus(lead({ status: "proposal_sent", _last_contact: call("Spoke") }))).toBe("quote");
    expect(sheetStatus(lead({ status: "won", _last_contact: call("Spoke") }))).toBe("won");
    expect(sheetStatus(lead({ status: "lost", _last_contact: call("Spoke") }))).toBe("lost");
    expect(sheetStatus(lead({ status: "junk" }))).toBe("junk");
  });
  it("reads a free-text contact subject through the status", () => {
    expect(sheetStatus(lead({ status: "tour_scheduled", _last_contact: call("Tour (tomorrow)") }))).toBe("tour");
    expect(sheetStatus(lead({ status: "contacted", _last_contact: call("Call") }))).toBe("spoke");
  });
  it("falls back to the status when no call was logged", () => {
    expect(sheetStatus(lead({ status: "contacted" }))).toBe("spoke");
    expect(sheetStatus(lead({ status: "tour_completed" }))).toBe("tour");
  });
});

describe("sheetLastAction", () => {
  it("is null when nobody has acted", () => {
    expect(sheetLastAction(lead())).toBeNull();
  });
  it("counts a lead the status says was worked as attended, so the colour and the filter agree", () => {
    for (const status of ["contacted", "tour_scheduled", "tour_completed"]) {
      expect(sheetLastAction(lead({ status }))).not.toBeNull();
      expect(sheetStatus(lead({ status }))).not.toBe("none");
    }
    expect(sheetLastAction(lead({ status: "new" }))).toBeNull();
  });
  it("names who logged a call", () => {
    expect(sheetLastAction(lead({ _last_contact: call("Spoke", "Vignesh") }))).toMatchObject({ label: "Spoke", by: "Vignesh", auto: false });
  });
  it("marks Proposal sent and Won as automatic, shown against the owner", () => {
    expect(sheetLastAction(lead({ status: "proposal_sent" }))).toMatchObject({ label: "Proposal sent", by: "Priya", auto: true });
    expect(sheetLastAction(lead({ status: "won" }))).toMatchObject({ label: "Won", auto: true });
  });
});

describe("day grouping", () => {
  it("splits rows into IST days, keeping their order", () => {
    const rows = [
      { created_at: "2026-11-24T08:00:00Z", n: 1 },
      { created_at: "2026-11-24T03:00:00Z", n: 2 },
      { created_at: "2026-11-23T10:00:00Z", n: 3 },
    ];
    const g = groupByDay(rows);
    expect(g.map((x) => [x.day, x.rows.map((r) => r.n)])).toEqual([
      ["2026-11-24", [1, 2]],
      ["2026-11-23", [3]],
    ]);
  });
  it("puts a late-evening UTC time on the next IST day", () => {
    expect(istDay("2026-11-23T20:00:00Z")).toBe("2026-11-24");
  });
  it("folds days older than a week only when nothing is filtered", () => {
    expect(startsFolded("2026-11-10", "2026-11-24", false)).toBe(true);
    expect(startsFolded("2026-11-17", "2026-11-24", false)).toBe(false);
    expect(startsFolded("2026-11-10", "2026-11-24", true)).toBe(false);
  });
  it("heads the day with Today, Yesterday or the date", () => {
    expect(dayHeading("2026-11-24", "2026-11-24")).toMatch(/^Today · /);
    expect(dayHeading("2026-11-23", "2026-11-24")).toMatch(/^Yesterday · /);
    expect(dayHeading("2026-11-20", "2026-11-24")).not.toMatch(/Today|Yesterday/);
  });
});

describe("waitingText", () => {
  it("reads minutes, hours and days", () => {
    const t = Date.parse("2026-11-24T12:00:00Z");
    expect(waitingText("2026-11-24T11:25:00Z", t)).toBe("35 min");
    expect(waitingText("2026-11-24T07:00:00Z", t)).toBe("5 h");
    expect(waitingText("2026-11-21T12:00:00Z", t)).toBe("3 d");
  });
});

describe("passesSheetFilters", () => {
  const none = { notContacted: false, lastAction: "", seats: "", statuses: [] as never[] };
  it("passes everything with no filters", () => {
    expect(passesSheetFilters(lead(), none)).toBe(true);
  });
  it("not contacted keeps only leads nobody has acted on", () => {
    expect(passesSheetFilters(lead(), { ...none, notContacted: true })).toBe(true);
    expect(passesSheetFilters(lead({ _last_contact: call("Spoke") }), { ...none, notContacted: true })).toBe(false);
  });
  it("last action matches the label", () => {
    expect(passesSheetFilters(lead({ _last_contact: call("Spoke") }), { ...none, lastAction: "Spoke" })).toBe(true);
    expect(passesSheetFilters(lead({ _last_contact: call("Spoke") }), { ...none, lastAction: "No answer" })).toBe(false);
  });
  it("statuses combine, and can be skipped for the guide's own counts", () => {
    const f = { ...none, statuses: ["none", "won"] as ("none" | "won")[] };
    expect(passesSheetFilters(lead(), f)).toBe(true);
    expect(passesSheetFilters(lead({ status: "lost" }), f)).toBe(false);
    expect(passesSheetFilters(lead({ status: "lost" }), f, { skipStatuses: true })).toBe(true);
  });
});

describe("standardActionLabel", () => {
  it("keeps the standard labels, whatever their case", () => {
    expect(standardActionLabel("Spoke")).toBe("Spoke");
    expect(standardActionLabel("no answer")).toBe("No answer");
    expect(standardActionLabel("Quote sent")).toBe("Quote sent");
  });
  it("turns the free text found in real data into a short fixed label", () => {
    expect(standardActionLabel("call")).toBe("Call logged");
    expect(standardActionLabel("Inbound call")).toBe("Call logged");
    expect(standardActionLabel("tour")).toBe("Tour booked");
    expect(standardActionLabel("Tour (yesterday, no outcome)")).toBe("Tour booked");
    expect(standardActionLabel("Conference Room Booking — Arcade Conference Room")).toBe("Room booking");
    expect(standardActionLabel("something else")).toBe("Contact logged");
  });
  it("shows the standard label in the last action, and the filter matches it", () => {
    const l = lead({ status: "contacted", _last_contact: call("call") });
    expect(sheetLastAction(l)?.label).toBe("Call logged");
    expect(passesSheetFilters(l, { notContacted: false, lastAction: "Call logged", seats: "", statuses: [] })).toBe(true);
    expect(sheetStatus(lead({ status: "tour_scheduled", _last_contact: call("tour") }))).toBe("tour");
  });
});

describe("seats filter", () => {
  const f = (seats: string) => ({ notContacted: false, lastAction: "", seats, statuses: [] as never[] });
  it("reads the lead's own seat count, else the enquiry's", () => {
    expect(sheetSeats(lead({ seat_capacity: 4 }))).toBe(4);
    expect(sheetSeats(lead({ _enquiry: { seat_capacity: 6 } }))).toBe(6);
    expect(sheetSeats(lead())).toBeNull();
  });
  it("matches a range, inclusive at both ends", () => {
    expect(passesSheetFilters(lead({ seat_capacity: 3 }), f("2-3"))).toBe(true);
    expect(passesSheetFilters(lead({ seat_capacity: 4 }), f("2-3"))).toBe(false);
    expect(passesSheetFilters(lead({ seat_capacity: 30 }), f("26+"))).toBe(true);
    expect(passesSheetFilters(lead({ seat_capacity: 1 }), f("1"))).toBe(true);
  });
  it("'not captured' keeps only leads with no seat count", () => {
    expect(passesSheetFilters(lead(), f("none"))).toBe(true);
    expect(passesSheetFilters(lead({ seat_capacity: 5 }), f("none"))).toBe(false);
    expect(passesSheetFilters(lead(), f("2-3"))).toBe(false);
  });
});

describe("flag", () => {
  const flagged = (over: Partial<SheetLeadInput> = {}) =>
    lead({ flagged_at: "2026-11-24T06:00:00Z", flag_reason: "Big company, call today", flagger: { full_name: "Priya" }, ...over });
  it("takes over the row colour from every status, closed ones included", () => {
    expect(sheetStatus(flagged())).toBe("flag");
    expect(sheetStatus(flagged({ status: "won" }))).toBe("flag");
    expect(sheetStatus(flagged({ status: "junk" }))).toBe("flag");
    expect(sheetStatus(lead({ flagged_at: null }))).toBe("none");
  });
  it("does not change the last action or what Not contacted means", () => {
    expect(sheetLastAction(flagged())).toBeNull();
    expect(sheetLastAction(flagged({ _last_contact: call("Spoke") }))?.label).toBe("Spoke");
  });
  it("says why, and who, on hover; nothing when not flagged", () => {
    expect(flagTooltip(flagged())).toBe("Flagged by Priya: Big company, call today");
    expect(flagTooltip(flagged({ flagger: null }))).toBe("Flagged: Big company, call today");
    expect(flagTooltip(lead())).toBe("");
  });
  it("can be picked in the colour guide like any status", () => {
    const f = { notContacted: false, lastAction: "", seats: "", statuses: ["flag"] as "flag"[] };
    expect(passesSheetFilters(flagged(), f)).toBe(true);
    expect(passesSheetFilters(lead(), f)).toBe(false);
  });
});

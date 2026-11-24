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
  const none = { notContacted: false, lastAction: "", statuses: [] as never[] };
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

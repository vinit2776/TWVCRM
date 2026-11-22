import { describe, it, expect } from "vitest";
import {
  firstTouchAt,
  parseEscalationMode,
  rungMessage,
  rungReached,
  rungRecipients,
  workingMinutesBetween,
} from "../enquiry-escalation";

// IST is UTC+5:30, so 09:00 IST is 03:30Z and 19:00 IST is 13:30Z.
// 2026-11-23 is a Monday; 2026-11-22 a Sunday; 2026-11-21 a Saturday.
const at = (day: string, hhmmIst: string) => {
  const [h, m] = hhmmIst.split(":").map(Number);
  return new Date(Date.parse(`${day}T00:00:00Z`) + (h * 60 + m - 330) * 60 * 1000);
};

describe("workingMinutesBetween", () => {
  it("counts plain minutes inside a working day", () => {
    expect(workingMinutesBetween(at("2026-11-23", "10:00"), at("2026-11-23", "10:45"))).toBe(45);
  });
  it("starts the clock at 9am for an enquiry that came in at night", () => {
    expect(workingMinutesBetween(at("2026-11-23", "22:00"), at("2026-11-24", "09:45"))).toBe(45);
    expect(workingMinutesBetween(at("2026-11-23", "07:00"), at("2026-11-23", "09:30"))).toBe(30);
  });
  it("skips Sundays", () => {
    // Saturday 18:30 to Monday 09:30: 30 minutes on Saturday, none on Sunday, 30 on Monday.
    expect(workingMinutesBetween(at("2026-11-21", "18:30"), at("2026-11-23", "09:30"))).toBe(60);
  });
  it("counts whole working days", () => {
    expect(workingMinutesBetween(at("2026-11-23", "09:00"), at("2026-11-24", "09:00"))).toBe(600);
  });
  it("is zero for a reversed or empty span", () => {
    expect(workingMinutesBetween(at("2026-11-23", "11:00"), at("2026-11-23", "10:00"))).toBe(0);
  });
});

describe("rungReached", () => {
  it("is null inside the target and climbs with time", () => {
    expect(rungReached(44)).toBeNull();
    expect(rungReached(45)).toBe("owner");
    expect(rungReached(89)).toBe("owner");
    expect(rungReached(90)).toBe("sales");
    expect(rungReached(179)).toBe("sales");
    expect(rungReached(180)).toBe("manager");
    expect(rungReached(5000)).toBe("manager");
  });
});

describe("firstTouchAt", () => {
  const received = "2026-11-23T04:00:00Z";
  it("is null while nothing has happened", () => {
    expect(firstTouchAt(received, [])).toBeNull();
  });
  it("takes the earliest real event at or after arrival", () => {
    expect(
      firstTouchAt(received, [
        { at: "2026-11-23T06:00:00Z", subject: "Call" },
        { at: "2026-11-23T05:00:00Z", subject: "Note" },
        { at: "2026-11-23T03:00:00Z", subject: "Old call" }, // before it arrived
      ]),
    ).toBe("2026-11-23T05:00:00Z");
  });
  it("ignores the system's hand-over notes, so claiming does not quiet the ladder", () => {
    expect(firstTouchAt(received, [{ at: "2026-11-23T04:05:00Z", subject: "Claimed" }, { at: "2026-11-23T04:06:00Z", subject: "Reassigned" }])).toBeNull();
  });
});

describe("rungRecipients", () => {
  const people = { ownerId: "o", salesIds: ["o", "s1", "s2"], managerIds: ["m1", "m2"] };
  it("tells the owner first, or the whole pool when nobody has taken it", () => {
    expect(rungRecipients("owner", people)).toEqual(["o"]);
    expect(rungRecipients("owner", { ...people, ownerId: null })).toEqual(["o", "s1", "s2"]);
  });
  it("then the other sales people, not the owner again", () => {
    expect(rungRecipients("sales", people)).toEqual(["s1", "s2"]);
  });
  it("then the managers", () => {
    expect(rungRecipients("manager", people)).toEqual(["m1", "m2"]);
  });
});

describe("rungMessage and mode", () => {
  it("makes a distinct title per rung (the dedupe key)", () => {
    const a = rungMessage("owner", "TWV-E-0100", "Priya", 46).title;
    const b = rungMessage("sales", "TWV-E-0100", "Priya", 91).title;
    expect(a).not.toBe(b);
    expect(rungMessage("manager", "TWV-E-0100", "Priya", 185).body).toContain("3h 5m");
  });
  it("reads an unknown mode as the safe one", () => {
    expect(parseEscalationMode(undefined)).toBe("dry_run");
    expect(parseEscalationMode("live")).toBe("live");
    expect(parseEscalationMode("off")).toBe("off");
  });
});

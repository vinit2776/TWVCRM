import { describe, expect, it } from "vitest";
import { waitTone, waitingReply } from "../whatsapp-replies";

const msg = (at: string, text: string) => ({ at, text });

describe("waitingReply", () => {
  it("is null when nobody has acted yet (it is still a new enquiry)", () => {
    expect(waitingReply([msg("2026-11-17T05:00:00Z", "hi, need 5 seats")], null)).toBeNull();
  });

  it("is null when the customer has not written since the last action", () => {
    expect(waitingReply([msg("2026-11-17T05:00:00Z", "need 5 seats")], "2026-11-17T06:00:00Z")).toBeNull();
  });

  it("counts what was written after the last action and measures from the oldest", () => {
    const r = waitingReply(
      [msg("2026-11-17T05:00:00Z", "need 5 seats"), msg("2026-11-17T07:00:00Z", "what is the price?"), msg("2026-11-17T07:30:00Z", "also parking?")],
      "2026-11-17T06:00:00Z"
    );
    expect(r).toMatchObject({ count: 2, quietCount: 0, waitingSince: "2026-11-17T07:00:00Z", latestText: "also parking?" });
  });

  it("does not reopen on a bare acknowledgement, but counts it", () => {
    expect(waitingReply([msg("2026-11-17T07:00:00Z", "ok thanks")], "2026-11-17T06:00:00Z")).toBeNull();
    const r = waitingReply([msg("2026-11-17T07:00:00Z", "ok"), msg("2026-11-17T07:05:00Z", "can I visit tomorrow?")], "2026-11-17T06:00:00Z");
    expect(r).toMatchObject({ count: 1, quietCount: 1, waitingSince: "2026-11-17T07:05:00Z" });
  });

  it("ignores messages with no timestamp", () => {
    expect(waitingReply([{ text: "old form text" }], "2026-11-17T06:00:00Z")).toBeNull();
  });
});

describe("waitTone", () => {
  const now = new Date("2026-11-17T12:00:00Z").getTime();
  it("turns amber after an hour and red after three", () => {
    expect(waitTone("2026-11-17T11:30:00Z", now)).toBe("ok");
    expect(waitTone("2026-11-17T10:45:00Z", now)).toBe("amber");
    expect(waitTone("2026-11-17T08:30:00Z", now)).toBe("red");
  });
});

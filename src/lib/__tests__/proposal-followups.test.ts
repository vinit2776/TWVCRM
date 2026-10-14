import { describe, it, expect } from "vitest";
import { computeFollowupActions, effectiveExpiryDate, type FollowupProposal } from "../proposal-followups";

const base: FollowupProposal = {
  status: "sent",
  sent_at: "2026-10-02T06:00:00Z",
  valid_until: "2026-10-16",
  payment_status: "pending",
  deposit_payment_status: "pending",
  nudge_1_sent_at: null,
  nudge_2_sent_at: null,
  rep_followup_notified_at: null,
};
const at = (iso: string) => new Date(iso);

describe("computeFollowupActions", () => {
  it("does nothing before day 3", () => {
    expect(computeFollowupActions(base, at("2026-10-04T05:00:00Z"))).toEqual({
      expire: false, nudge1: false, nudge2: false, notifyRep: false,
    });
  });

  it("sends nudge 1 on day 3", () => {
    const a = computeFollowupActions(base, at("2026-10-05T05:00:00Z"));
    expect(a.nudge1).toBe(true);
    expect(a.notifyRep).toBe(false);
  });

  it("prompts the rep on day 5", () => {
    expect(computeFollowupActions(base, at("2026-10-07T05:00:00Z")).notifyRep).toBe(true);
  });

  it("sends nudge 2 on day 10 and not nudge 1 alongside it", () => {
    const a = computeFollowupActions(base, at("2026-10-12T05:00:00Z"));
    expect(a.nudge2).toBe(true);
    expect(a.nudge1).toBe(false);
  });

  it("never repeats a nudge already sent", () => {
    const a = computeFollowupActions(
      { ...base, nudge_1_sent_at: "2026-10-05T05:00:00Z", rep_followup_notified_at: "2026-10-07T05:00:00Z" },
      at("2026-10-08T05:00:00Z")
    );
    expect(a).toEqual({ expire: false, nudge1: false, nudge2: false, notifyRep: false });
  });

  it("expires the day after valid_until, not on it", () => {
    expect(computeFollowupActions(base, at("2026-10-16T05:00:00Z")).expire).toBe(false);
    expect(computeFollowupActions(base, at("2026-10-17T05:00:00Z")).expire).toBe(true);
  });

  it("falls back to sent date + 14 days without valid_until", () => {
    expect(effectiveExpiryDate({ sent_at: base.sent_at, valid_until: null })).toBe("2026-10-16");
  });

  it("leaves paid and non-waiting proposals alone", () => {
    const now = at("2026-10-20T05:00:00Z");
    expect(computeFollowupActions({ ...base, payment_status: "paid" }, now).expire).toBe(false);
    expect(computeFollowupActions({ ...base, deposit_payment_status: "paid" }, now).expire).toBe(false);
    expect(computeFollowupActions({ ...base, status: "accepted" }, now).expire).toBe(false);
    expect(computeFollowupActions({ ...base, status: "draft" }, now).expire).toBe(false);
  });

  it("never nudges a backlog proposal sent over 30 days ago, and expires it only if lapsed", () => {
    const old = { ...base, sent_at: "2026-08-01T06:00:00Z", valid_until: "2026-12-31" };
    expect(computeFollowupActions(old, at("2026-10-12T05:00:00Z"))).toEqual({
      expire: false, nudge1: false, nudge2: false, notifyRep: false,
    });
  });

  it("uses the IST calendar day, so 19:00 UTC counts as the next day", () => {
    expect(computeFollowupActions(base, at("2026-10-16T19:00:00Z")).expire).toBe(true);
  });
});

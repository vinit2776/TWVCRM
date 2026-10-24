import { describe, it, expect } from "vitest";
import {
  startRenewalBlockers,
  partnerConfirmBlockers,
  lapseDecisionBlockers,
  startRenewalAfter,
  lapseDecisionAfter,
  partnerConfirmAfter,
  RENEWAL_GLOSSARY,
} from "@/lib/vo-renewal-guidance";

const ready = { ready: true, cannotStart: false, mode: "agreed", customPct: "", reason: "", endConfirmed: true };

describe("startRenewalBlockers", () => {
  it("is empty when nothing is in the way", () => {
    expect(startRenewalBlockers(ready)).toEqual([]);
  });

  it("is empty before the dialog has an offer, and when the case can't be renewed at all", () => {
    expect(startRenewalBlockers({ ...ready, ready: false, endConfirmed: false })).toEqual([]);
    expect(startRenewalBlockers({ ...ready, cannotStart: true, endConfirmed: false })).toEqual([]);
  });

  it("asks for the end date to be confirmed", () => {
    expect(startRenewalBlockers({ ...ready, endConfirmed: false })).toEqual([
      "Tick the box to confirm the new term's end date.",
    ]);
  });

  it("asks for the percentage and the reason on a custom escalation", () => {
    const r = startRenewalBlockers({ ...ready, mode: "custom", customPct: "", reason: "short" });
    expect(r).toHaveLength(2);
    expect(r[0]).toContain("custom escalation percentage");
    expect(r[1]).toContain("at least 10 characters");
  });

  it("accepts a custom escalation once both are given", () => {
    expect(startRenewalBlockers({ ...ready, mode: "custom", customPct: "8", reason: "Agreed on call 12 Dec" })).toEqual([]);
  });
});

describe("partnerConfirmBlockers", () => {
  const p = { ready: true, cannotConfirm: false, mode: "agreed", customPct: "", reason: "", endConfirmed: true, noteLength: 20 };

  it("is empty when everything is filled in", () => {
    expect(partnerConfirmBlockers(p)).toEqual([]);
  });

  it("asks for the note and the confirmation", () => {
    const r = partnerConfirmBlockers({ ...p, endConfirmed: false, noteLength: 3 });
    expect(r).toHaveLength(2);
    expect(r[1]).toContain("who confirmed it");
  });

  it("leaves the hard blockers to the dialog's own banner", () => {
    expect(partnerConfirmBlockers({ ...p, cannotConfirm: true, noteLength: 0 })).toEqual([]);
  });
});

describe("lapseDecisionBlockers", () => {
  const base = { decision: "paid" as const, reasonLength: 20, until: "", today: "2027-01-05", latestGraceDate: "2027-01-20" };

  it("is empty before a decision is chosen", () => {
    expect(lapseDecisionBlockers({ ...base, decision: null, reasonLength: 0 })).toEqual([]);
  });

  it("asks for a reason", () => {
    expect(lapseDecisionBlockers({ ...base, reasonLength: 4 })).toHaveLength(1);
  });

  it("checks the more-time date against today and the latest allowed", () => {
    const more = { ...base, decision: "more_time" as const };
    expect(lapseDecisionBlockers(more)[0]).toContain("Choose the date");
    expect(lapseDecisionBlockers({ ...more, until: "2027-01-05" })[0]).toBe("Choose a date after today.");
    expect(lapseDecisionBlockers({ ...more, until: "2027-02-01" })[0]).toContain("no later than");
    expect(lapseDecisionBlockers({ ...more, until: "2027-01-12" })).toEqual([]);
  });
});

describe("after-action messages", () => {
  const link = { termStart: "2026-12-19", hasLink: true };

  it("says nothing was sent when no channel was ticked", () => {
    const r = startRenewalAfter({ ...link, email: { ticked: false, sent: false }, whatsApp: { ticked: false, sent: false } });
    expect(r.kind).toBe("success");
    expect(r.message).toContain("Nothing was sent");
    expect(r.message).toContain("Dec 19, 2026");
  });

  it("names the channels that delivered", () => {
    const r = startRenewalAfter({ ...link, email: { ticked: true, sent: true }, whatsApp: { ticked: true, sent: true } });
    expect(r.message).toContain("sent by email and WhatsApp");
  });

  it("warns when a ticked channel failed", () => {
    const r = startRenewalAfter({ ...link, email: { ticked: true, sent: false }, whatsApp: { ticked: false, sent: false } });
    expect(r.kind).toBe("warning");
    expect(r.message).toContain("Share the payment link yourself");
  });

  it("says so when the bill has no link", () => {
    const r = startRenewalAfter({ termStart: "2026-12-19", hasLink: false, email: { ticked: false, sent: false }, whatsApp: { ticked: false, sent: false } });
    expect(r.message).toContain("without a payment link");
  });

  it("explains each lapse decision", () => {
    expect(lapseDecisionAfter("paid")).toContain("Report the payment");
    expect(lapseDecisionAfter("more_time", "2027-01-12")).toContain("Jan 12, 2027");
    expect(lapseDecisionAfter("discontinue")).toContain("nothing goes to the client until each one is approved");
  });

  it("explains a partner confirmation", () => {
    expect(partnerConfirmAfter({ rolled: true, termStart: "2026-12-19" })).toContain("its own case");
    expect(partnerConfirmAfter({ rolled: false, termStart: "2026-12-19" })).toContain("Dec 19, 2026");
  });
});

describe("glossary", () => {
  it("defines every term with a label and a sentence", () => {
    for (const e of Object.values(RENEWAL_GLOSSARY)) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.definition.length).toBeGreaterThan(20);
    }
  });
});

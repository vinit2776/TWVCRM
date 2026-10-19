import { describe, it, expect } from "vitest";
import { attachTo, autoResolutions, deriveProgress, type ProgressEnquiry } from "../enquiry-progress";

const enq = (id: string, received_at: string, extra: Partial<ProgressEnquiry> = {}): ProgressEnquiry => ({
  id, received_at, claimed_at: null, resolved_at: null, ...extra,
});
const NOW = new Date("2026-11-30T00:00:00Z");

describe("attachTo", () => {
  const list = [enq("old", "2026-08-01T00:00:00Z"), enq("new", "2026-10-20T00:00:00Z")];
  it("picks the newest enquiry received before the event", () => {
    expect(attachTo(list, "2026-10-25T00:00:00Z")).toBe("new");
    expect(attachTo(list, "2026-10-10T00:00:00Z")).toBe("old");
  });
  it("ignores an event before any enquiry, and one beyond the attach window", () => {
    expect(attachTo(list, "2026-07-01T00:00:00Z")).toBeNull();
    expect(attachTo([enq("old", "2026-01-01T00:00:00Z")], "2026-11-01T00:00:00Z")).toBeNull();
  });
});

describe("deriveProgress", () => {
  it("walks an enquiry from contacted through to active", () => {
    const e = enq("e1", "2026-10-19T00:00:00Z", { claimed_at: "2026-10-19T10:00:00Z" });
    const p = deriveProgress(
      [e],
      [{ id: "p1", sent_at: "2026-10-21T00:00:00Z", viewed_at: null, paid_at: "2026-10-24T00:00:00Z" }],
      [{ id: "c1", proposal_id: "p1", is_renewal: false, sent_at: "2026-10-25T00:00:00Z", signed_at: "2026-10-26T00:00:00Z", activated_at: "2026-10-28T00:00:00Z" }]
    ).get("e1")!;
    expect(p.stage.key).toBe("active");
    expect(p.milestones.map((m) => m.key)).toEqual(["proposal_sent", "deposit_paid", "contract_sent", "contract_signed", "active"]);
  });
  it("a draft proposal is not progress; an unclaimed enquiry is New", () => {
    const p = deriveProgress([enq("e1", "2026-10-19T00:00:00Z")], [{ id: "p1", sent_at: null, viewed_at: null, paid_at: null }], []).get("e1")!;
    expect(p.stage.key).toBe("new");
  });
  it("puts a returning customer's later proposal on the new enquiry, not the old", () => {
    const m = deriveProgress(
      [enq("old", "2026-08-01T00:00:00Z"), enq("new", "2026-11-01T00:00:00Z")],
      [{ id: "p1", sent_at: "2026-11-03T00:00:00Z", viewed_at: null, paid_at: null }],
      []
    );
    expect(m.get("new")!.stage.key).toBe("proposal_sent");
    expect(m.get("old")!.milestones).toHaveLength(0);
  });
  it("keeps a contract with the enquiry of its proposal even if a newer enquiry exists", () => {
    const m = deriveProgress(
      [enq("a", "2026-10-01T00:00:00Z"), enq("b", "2026-10-26T00:00:00Z")],
      [{ id: "p1", sent_at: "2026-10-05T00:00:00Z", viewed_at: null, paid_at: null }],
      [{ id: "c1", proposal_id: "p1", is_renewal: false, sent_at: "2026-10-27T00:00:00Z", signed_at: null, activated_at: null }]
    );
    expect(m.get("a")!.stage.key).toBe("contract_sent");
    expect(m.get("b")!.milestones).toHaveLength(0);
  });
  it("ignores renewals", () => {
    const m = deriveProgress([enq("a", "2026-10-01T00:00:00Z")], [], [{ id: "c1", proposal_id: null, is_renewal: true, sent_at: "2026-10-03T00:00:00Z", signed_at: null, activated_at: null }]);
    expect(m.get("a")!.milestones).toHaveLength(0);
  });
});

describe("autoResolutions", () => {
  const CUT = "2026-10-15T00:00:00Z";
  it("converts when a contract is active", () => {
    const e = enq("e1", "2026-10-19T00:00:00Z");
    const pr = deriveProgress([e], [], [{ id: "c", proposal_id: null, is_renewal: false, sent_at: "2026-10-20T00:00:00Z", signed_at: null, activated_at: "2026-10-28T00:00:00Z" }]);
    expect(autoResolutions([e], pr, "won", NOW, CUT)).toEqual([{ enquiryId: "e1", outcome: "converted", reason: "contract activated" }]);
  });
  it("resolves as not interested when the lead is lost", () => {
    const e = enq("e1", "2026-11-25T00:00:00Z");
    expect(autoResolutions([e], deriveProgress([e], [], []), "lost", NOW, CUT)[0].outcome).toBe("not_interested");
  });
  it("resolves as no response only after 21 quiet days, counting the latest touch", () => {
    const quiet = enq("q", "2026-10-20T00:00:00Z");
    const chatty = enq("c", "2026-10-20T00:00:00Z", { last_touch_at: "2026-11-25T00:00:00Z" });
    const pr = deriveProgress([quiet, chatty], [], []);
    expect(autoResolutions([quiet, chatty], pr, "new", NOW, CUT).map((r) => r.enquiryId)).toEqual(["q"]);
  });
  it("never touches enquiries received before the cut-off, resolved ones, or when there is no cut-off", () => {
    const before = enq("b", "2026-09-01T00:00:00Z");
    const done = enq("d", "2026-10-20T00:00:00Z", { resolved_at: "2026-10-22T00:00:00Z" });
    const pr = deriveProgress([before, done], [], []);
    expect(autoResolutions([before, done], pr, "lost", NOW, CUT)).toEqual([]);
    expect(autoResolutions([enq("x", "2026-10-20T00:00:00Z")], pr, "lost", NOW, null)).toEqual([]);
  });
});

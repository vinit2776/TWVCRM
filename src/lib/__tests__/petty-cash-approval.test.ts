import { describe, it, expect } from "vitest";
import {
  buildRejectNote, resubmitStage, canDecideEntry, canDecideRequest, computeEntryFlags, isCleanForBulk, nextStatusOnApprove,
  type FlagInput,
} from "../petty-cash-approval";

const e = (status: string, by = "owner") => ({ submitted_by: by, status });

describe("canDecideEntry", () => {
  it("blocks deciding your own expense at any stage, even as admin", () => {
    expect(canDecideEntry("admin", "u1", e("pending_manager", "u1")).ok).toBe(false);
    expect(canDecideEntry("admin", "u1", e("pending_admin", "u1")).ok).toBe(false);
  });
  it("stage 1 is manager/admin only", () => {
    expect(canDecideEntry("manager", "m", e("pending_manager")).ok).toBe(true);
    expect(canDecideEntry("admin", "a", e("pending_manager")).ok).toBe(true);
    expect(canDecideEntry("accounts", "x", e("pending_manager")).ok).toBe(false);
  });
  it("stage 2 is admin/accounts only", () => {
    expect(canDecideEntry("accounts", "x", e("pending_admin")).ok).toBe(true);
    expect(canDecideEntry("manager", "m", e("pending_admin")).ok).toBe(false);
  });
  it("refuses an expense that is already decided", () => {
    expect(canDecideEntry("admin", "a", e("approved")).ok).toBe(false);
    expect(canDecideEntry("admin", "a", e("rejected")).ok).toBe(false);
  });
});

describe("nextStatusOnApprove", () => {
  it("small amounts finish at stage 1", () => {
    expect(nextStatusOnApprove("manager", "pending_manager", 4999, 5000)).toBe("approved");
  });
  it("large amounts from a manager go to the second stage", () => {
    expect(nextStatusOnApprove("manager", "pending_manager", 5000, 5000)).toBe("pending_admin");
  });
  it("an admin approving a large amount at stage 1 finishes it in one step", () => {
    expect(nextStatusOnApprove("admin", "pending_manager", 9000, 5000)).toBe("approved");
  });
  it("stage 2 always finishes", () => {
    expect(nextStatusOnApprove("accounts", "pending_admin", 9000, 5000)).toBe("approved");
  });
});

describe("canDecideRequest", () => {
  const r = (created_by = "owner", status = "pending") => ({ created_by, status });
  it("only an admin can approve fund requests", () => {
    expect(canDecideRequest("admin", "a", r()).ok).toBe(true);
    expect(canDecideRequest("manager", "m", r()).ok).toBe(false);
    expect(canDecideRequest("accounts", "x", r()).ok).toBe(false);
  });
  it("an admin cannot approve their own request", () => {
    expect(canDecideRequest("admin", "a", r("a")).ok).toBe(false);
  });
  it("refuses a request that is not pending", () => {
    expect(canDecideRequest("admin", "a", r("owner", "approved")).ok).toBe(false);
  });
});

describe("computeEntryFlags", () => {
  const base: FlagInput = { amount: 500, attachmentCount: 1, nudgeAmount: 1000, categoryName: "Food", usualAvg: null, usualSamples: 0, duplicateOn: null };
  it("has no flags for a clean expense", () => expect(computeEntryFlags(base)).toEqual([]));
  it("flags a missing bill only at or above the nudge amount", () => {
    expect(computeEntryFlags({ ...base, amount: 1000, attachmentCount: 0 }).map((f) => f.code)).toEqual(["no_bill"]);
    expect(computeEntryFlags({ ...base, amount: 999, attachmentCount: 0 })).toEqual([]);
  });
  it("flags a duplicate amount", () => {
    expect(computeEntryFlags({ ...base, duplicateOn: "6 Nov" })[0].code).toBe("duplicate_amount");
  });
  it("flags 2x usual, but only with enough history", () => {
    expect(computeEntryFlags({ ...base, amount: 1200, usualAvg: 600, usualSamples: 3 })[0].code).toBe("above_usual");
    expect(computeEntryFlags({ ...base, amount: 1200, usualAvg: 600, usualSamples: 2 })).toEqual([]);
  });
});

describe("isCleanForBulk", () => {
  const ok = { amount: 640, attachmentCount: 1, flags: [], own: false, stage: "pending_manager" as const };
  it("accepts a small, receipted, unflagged item", () => expect(isCleanForBulk(ok)).toBe(true));
  it("rejects each disqualifier", () => {
    expect(isCleanForBulk({ ...ok, amount: 1001 })).toBe(false);
    expect(isCleanForBulk({ ...ok, attachmentCount: 0 })).toBe(false);
    expect(isCleanForBulk({ ...ok, own: true })).toBe(false);
    expect(isCleanForBulk({ ...ok, stage: "pending_admin" })).toBe(false);
    expect(isCleanForBulk({ ...ok, flags: [{ code: "no_bill", message: "" }] })).toBe(false);
  });
});

describe("buildRejectNote", () => {
  it("joins reasons and detail", () => {
    expect(buildRejectNote(["Bill is missing", "Wrong category"], " please fix ")).toBe("Bill is missing. Wrong category. please fix");
    expect(buildRejectNote([], "")).toBe("");
  });
});

describe("resubmitStage", () => {
  const base = { oldAmount: 6000, newAmount: 6000, threshold: 5000 };
  it("a first-stage rejection restarts at the manager", () => {
    expect(resubmitStage({ ...base, rejectedLevel: "manager" })).toBe("pending_manager");
  });
  it("a second-stage rejection returns to the second stage when the amount is not higher", () => {
    expect(resubmitStage({ ...base, rejectedLevel: "admin" })).toBe("pending_admin");
    expect(resubmitStage({ ...base, rejectedLevel: "admin", newAmount: 5500 })).toBe("pending_admin");
  });
  it("restarts at the manager if the amount went up or no longer needs a second approval", () => {
    expect(resubmitStage({ ...base, rejectedLevel: "admin", newAmount: 7000 })).toBe("pending_manager");
    expect(resubmitStage({ ...base, rejectedLevel: "admin", newAmount: 4000 })).toBe("pending_manager");
  });
  it("defaults to the manager when the rejecting stage is unknown", () => {
    expect(resubmitStage({ ...base, rejectedLevel: null })).toBe("pending_manager");
  });
});

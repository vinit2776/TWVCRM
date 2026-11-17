import { describe, it, expect } from "vitest";
import {
  allWarnings,
  canPrepareKyc,
  canSignOffKyc,
  checkSignoff,
  flagsNeedingAck,
  kycStep,
  latestPortalChecks,
  relevantAcks,
  validatePortalCheck,
  type KycReviewSnapshot,
  type PortalCheck,
} from "../vo-kyc-review";
import type { Flag } from "../vo-kyc-validators";

const warn: Flag = { code: "pan_entity", severity: "warning", field: "companyPan", message: "x" };
const ok: Flag = { code: "pan_format", severity: "ok", field: "companyPan", message: "x" };
const info: Flag = { code: "n", severity: "info", field: "f", message: "x" };
const serious: Flag = { code: "gstin_pan", severity: "serious", field: "gstin", message: "x" };

const snap = (over: Partial<KycReviewSnapshot> = {}): KycReviewSnapshot => ({
  checksRunAt: "2026-11-01T00:00:00Z",
  reviewedAt: null,
  flags: [],
  portalChecks: [],
  ...over,
});

const check = (check_type: string, result: string, checked_at: string): PortalCheck => ({
  check_type,
  result,
  evidence_note: null,
  checked_at,
});

describe("roles", () => {
  it("lets sales_rep prepare but not sign off", () => {
    expect(canPrepareKyc("sales_rep")).toBe(true);
    expect(canSignOffKyc("sales_rep")).toBe(false);
    expect(canSignOffKyc("manager")).toBe(true);
    expect(canSignOffKyc("admin")).toBe(true);
    expect(canPrepareKyc("accounts")).toBe(false);
  });
});

describe("flagsNeedingAck", () => {
  it("keeps only warning and serious", () => {
    expect(flagsNeedingAck([ok, info, warn, serious]).map((f) => f.code)).toEqual(["pan_entity", "gstin_pan"]);
  });
});

describe("portal checks", () => {
  it("uses the newest record per type", () => {
    const latest = latestPortalChecks([
      check("pan_income_tax", "mismatch", "2026-11-01"),
      check("pan_income_tax", "matched", "2026-11-02"),
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0].result).toBe("matched");
  });

  it("turns a non-matched result into a warning", () => {
    const w = allWarnings([], [check("gstin_portal", "not_found", "2026-11-01")]);
    expect(w.map((f) => f.code)).toEqual(["portal_gstin_portal"]);
  });

  it("requires a note unless matched", () => {
    expect(validatePortalCheck({ check_type: "pan_income_tax", result: "matched" })).toBeNull();
    expect(validatePortalCheck({ check_type: "pan_income_tax", result: "mismatch" })).not.toBeNull();
    expect(validatePortalCheck({ check_type: "pan_income_tax", result: "mismatch", evidence_note: "name differs" })).toBeNull();
    expect(validatePortalCheck({ check_type: "bogus", result: "matched" })).not.toBeNull();
  });
});

describe("kycStep", () => {
  it("moves through the two steps", () => {
    expect(kycStep(snap({ checksRunAt: null }))).toBe("not_started");
    expect(kycStep(snap())).toBe("awaiting_signoff");
    expect(kycStep(snap({ reviewedAt: "2026-11-03" }))).toBe("reviewed");
  });
});

describe("checkSignoff", () => {
  it("blocks sign-off before step 1", () => {
    expect(checkSignoff(snap({ checksRunAt: null }), []).ok).toBe(false);
  });

  it("allows sign-off with no warnings", () => {
    expect(checkSignoff(snap({ flags: [ok, info] }), []).ok).toBe(true);
  });

  it("lists warnings that have no acknowledgement", () => {
    const r = checkSignoff(snap({ flags: [warn, serious] }), [{ code: "pan_entity", reason: "Verified with client by phone" }]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["gstin_pan"]);
  });

  it("rejects a reason that is too short", () => {
    const r = checkSignoff(snap({ flags: [warn] }), [{ code: "pan_entity", reason: "ok" }]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["pan_entity"]);
  });

  it("requires acknowledging a bad portal result too", () => {
    const s = snap({ portalChecks: [check("mca_master_data", "mismatch", "2026-11-01")] });
    expect(checkSignoff(s, []).missing).toEqual(["portal_mca_master_data"]);
    expect(checkSignoff(s, [{ code: "portal_mca_master_data", reason: "Renamed company, new COI seen" }]).ok).toBe(true);
  });

  it("passes when every warning is answered", () => {
    const r = checkSignoff(snap({ flags: [warn, serious] }), [
      { code: "pan_entity", reason: "Sole proprietor using personal PAN" },
      { code: "gstin_pan", reason: "GSTIN belongs to the branch, confirmed" },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("relevantAcks", () => {
  it("drops acknowledgements for codes that are not warnings and trims reasons", () => {
    const out = relevantAcks(snap({ flags: [warn] }), [
      { code: "pan_entity", reason: "  fine reason here  " },
      { code: "stray", reason: "not a warning at all" },
    ]);
    expect(out).toEqual([{ code: "pan_entity", reason: "fine reason here" }]);
  });
});

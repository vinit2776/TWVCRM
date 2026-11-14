import { describe, it, expect } from "vitest";
import { buildVoProposalBody, isBelowFloor, parseQuotedRate, validateVoForm, type VoFormValues, type VoPricingView } from "@/lib/vo-proposal-form";
import { computeVoPricing } from "@/lib/vo-pricing";

const rows = [{ id: "r1", purpose: "gst_new", location_id: null, guide_fee: 12000, floor_fee: 9000, default_term_months: 12, version: 1 }];
const pricing = computeVoPricing({ purpose: "gst_new", locationId: "loc", termMonths: 12, rows });
if (!pricing.ok) throw new Error("fixture");
const ready: VoPricingView = { state: "ready", pricing };

const base: VoFormValues = { title: "Acme VO", purpose: "gst_new", locationId: "loc", termMonths: 12, quotedRate: "10000", belowFloorReason: "" };

describe("parseQuotedRate", () => {
  it("accepts positive numbers only", () => {
    expect(parseQuotedRate("10000")).toBe(10000);
    expect(parseQuotedRate("")).toBeNull();
    expect(parseQuotedRate("0")).toBeNull();
    expect(parseQuotedRate("abc")).toBeNull();
  });
});

describe("validateVoForm", () => {
  it("passes a complete at-guide quote", () => expect(validateVoForm(base, ready)).toBeNull());
  it("allows a quote above the guide (guide is not a cap)", () => expect(validateVoForm({ ...base, quotedRate: "50000" }, ready)).toBeNull());
  it("requires purpose, location, term and title", () => {
    expect(validateVoForm({ ...base, title: " " }, ready)).toMatch(/title/);
    expect(validateVoForm({ ...base, purpose: "" }, ready)).toMatch(/purpose/);
    expect(validateVoForm({ ...base, locationId: null }, ready)).toMatch(/location/);
    expect(validateVoForm({ ...base, termMonths: 6 }, ready)).toMatch(/term/);
  });
  it("blocks with the server message when no rate exists", () => {
    expect(validateVoForm(base, { state: "no_rate", message: "No rate card exists" })).toBe("No rate card exists");
  });
  it("requires a reason below the floor", () => {
    expect(isBelowFloor(ready, 8999)).toBe(true);
    expect(isBelowFloor(ready, 9000)).toBe(false);
    expect(validateVoForm({ ...base, quotedRate: "8000" }, ready)).toMatch(/below the floor/);
    expect(validateVoForm({ ...base, quotedRate: "8000", belowFloorReason: "Anchor client" }, ready)).toBeNull();
  });
  it("does not gate on the floor before rates are set up", () => {
    expect(validateVoForm({ ...base, quotedRate: "1" }, { state: "not_set_up" })).toBeNull();
  });
});

describe("buildVoProposalBody", () => {
  it("builds a zero-deposit VO body with the whole-term fee", () => {
    const body = buildVoProposalBody({ ...base, purpose: "gst_new", termMonths: 24, quotedRate: "10000" }, "lead1", false);
    expect(body.kind).toBe("virtual_office");
    expect(body.security_deposit_months).toBe(0);
    expect(body.items[0].unit_price).toBe(20000);
    expect(body.lock_in_months).toBe(24);
    expect("vo_below_floor_reason" in body).toBe(false);
  });
  it("includes the reason only when below the floor", () => {
    const body = buildVoProposalBody({ ...base, purpose: "gst_new", termMonths: 12, quotedRate: "8000", belowFloorReason: " Anchor client " }, "lead1", true);
    expect(body.vo_below_floor_reason).toBe("Anchor client");
  });
});

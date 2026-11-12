import { describe, it, expect } from "vitest";
import {
  checkConnectionInput, cleanAliases, consumerKey, describeConflict, findConflicts, nameKey,
  MAX_ALIASES, type ConnectionLike,
} from "../electricity-connections";

const conn = (over: Partial<ConnectionLike> = {}): ConnectionLike => ({
  id: "c1", location_id: "locA", vendor_id: "v1", consumer_number: "09-345-772-1180", bill_aliases: [], is_active: true, ...over,
});

describe("consumerKey — must mirror the generated SQL column", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(consumerKey("09-345-772-1180")).toBe("093457721180");
    expect(consumerKey(" 09 345 772 1180 ")).toBe("093457721180");
    expect(consumerKey("TN/09.345-772/1180")).toBe("tn093457721180");
    expect(consumerKey("tn/09.345-772/1180")).toBe("tn093457721180");
  });
  it("is null for blank or punctuation-only input", () => {
    expect(consumerKey("")).toBeNull();
    expect(consumerKey("  - / ")).toBeNull();
    expect(consumerKey(null)).toBeNull();
    expect(consumerKey(undefined)).toBeNull();
  });
});

describe("nameKey", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(nameKey("WORKVILLA SERVICES PVT LTD – PLOT 14")).toBe(nameKey("workvilla services pvt. ltd., plot-14"));
  });
  it("keeps letters from other scripts instead of collapsing them to nothing", () => {
    expect(nameKey("வொர்க்வில்லா")).not.toBeNull();
    expect(nameKey("வொர்க்வில்லா")).not.toBe(nameKey("வேறு பெயர்"));
  });
  it("is null when there is nothing to compare", () => {
    expect(nameKey("  ... ")).toBeNull();
    expect(nameKey(null)).toBeNull();
  });
});

describe("cleanAliases", () => {
  it("trims, collapses spaces, drops blanks and repeats but keeps the first wording", () => {
    expect(cleanAliases(["  Unit   4B ", "unit 4b", "", "  ", "Tenant: Workvilla – Block A"])).toEqual(["Unit 4B", "Tenant: Workvilla – Block A"]);
  });
  it("copes with nothing", () => {
    expect(cleanAliases(null)).toEqual([]);
    expect(cleanAliases([])).toEqual([]);
  });
});

describe("findConflicts", () => {
  const existing = [
    conn({ id: "a", location_id: "locA", consumer_number: "09-345-772-1180", bill_aliases: ["WORKVILLA SERVICES – PLOT 14"] }),
    conn({ id: "b", location_id: "locB", consumer_number: "09-221-554-0032", bill_aliases: [] }),
    conn({ id: "z", location_id: "locZ", vendor_id: "v2", consumer_number: "09-345-772-1180" }),            // other vendor
    conn({ id: "x", location_id: "locX", consumer_number: "09-999-000-0001", is_active: false }),         // deactivated
  ];

  it("finds a consumer number already used by the same vendor, however it is punctuated", () => {
    const c = findConflicts(existing, { vendor_id: "v1", consumer_number: "093457721180", bill_aliases: [] });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "consumer_number", with: { id: "a" } });
  });

  it("finds a remembered name already used by the same vendor", () => {
    const c = findConflicts(existing, { vendor_id: "v1", consumer_number: null, bill_aliases: ["workvilla services - plot 14"] });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "alias", with: { id: "a" } });
  });

  it("the same number under a different vendor is fine", () => {
    expect(findConflicts(existing, { vendor_id: "v3", consumer_number: "09-345-772-1180", bill_aliases: [] })).toHaveLength(0);
  });

  it("a deactivated connection frees its number", () => {
    expect(findConflicts(existing, { vendor_id: "v1", consumer_number: "09-999-000-0001", bill_aliases: [] })).toHaveLength(0);
  });

  it("editing a connection does not conflict with itself", () => {
    expect(findConflicts(existing, { vendor_id: "v1", consumer_number: "09-345-772-1180", bill_aliases: ["WORKVILLA SERVICES – PLOT 14"] }, "a")).toHaveLength(0);
  });

  it("reports every clash, number and names", () => {
    const c = findConflicts(existing, { vendor_id: "v1", consumer_number: "09-221-554-0032", bill_aliases: ["Workvilla Services - Plot 14"] });
    expect(c.map((x) => x.kind).sort()).toEqual(["alias", "consumer_number"]);
  });

  it("a connection with no identifiers conflicts with nothing", () => {
    expect(findConflicts(existing, { vendor_id: "v1", consumer_number: null, bill_aliases: [] })).toHaveLength(0);
  });
});

describe("checkConnectionInput", () => {
  it("warns, but allows, a connection with no identifier at all", () => {
    const r = checkConnectionInput({ consumer_number: null, bill_aliases: [], sanctioned_kva: null });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/never be recognised automatically/);
  });
  it("does not warn when either identifier is present", () => {
    expect(checkConnectionInput({ consumer_number: "09-1", bill_aliases: [], sanctioned_kva: null }).warnings).toEqual([]);
    expect(checkConnectionInput({ consumer_number: null, bill_aliases: ["Unit 4B"], sanctioned_kva: null }).warnings).toEqual([]);
  });
  it("treats a punctuation-only number as no number", () => {
    expect(checkConnectionInput({ consumer_number: " - ", bill_aliases: [], sanctioned_kva: null }).warnings).toHaveLength(1);
  });
  it("rejects limits being exceeded and a non-positive demand", () => {
    expect(checkConnectionInput({ consumer_number: "x".repeat(61), bill_aliases: [], sanctioned_kva: null }).errors).toHaveLength(1);
    const many = Array.from({ length: MAX_ALIASES + 1 }, (_, i) => `name ${i}`);
    expect(checkConnectionInput({ consumer_number: null, bill_aliases: many, sanctioned_kva: null }).errors).toHaveLength(1);
    expect(checkConnectionInput({ consumer_number: "1", bill_aliases: ["y".repeat(121)], sanctioned_kva: null }).errors).toHaveLength(1);
    expect(checkConnectionInput({ consumer_number: "1", bill_aliases: [], sanctioned_kva: 0 }).errors).toHaveLength(1);
    expect(checkConnectionInput({ consumer_number: "1", bill_aliases: [], sanctioned_kva: -5 }).errors).toHaveLength(1);
  });
});

describe("describeConflict", () => {
  it("names the other location", () => {
    const loc = (id: string) => (id === "locB" ? "Location B" : id);
    const n = describeConflict({ kind: "consumer_number", with: conn({ location_id: "locB", consumer_number: "09-221" }) }, loc);
    expect(n).toMatch(/09-221/);
    expect(n).toMatch(/Location B/);
    const a = describeConflict({ kind: "alias", alias: "Unit 4B", with: conn({ location_id: "locB" }) }, loc);
    expect(a).toMatch(/Unit 4B/);
  });
});

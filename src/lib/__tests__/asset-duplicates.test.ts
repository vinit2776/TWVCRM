import { describe, it, expect } from "vitest";
import { findPossibleDuplicates, normaliseSerial } from "../asset-duplicates";

describe("normaliseSerial", () => {
  it("ignores case and spaces", () => expect(normaliseSerial(" hvf 00117 ")).toBe("hvf00117"));
  it("treats blanks, short values and placeholders as no serial", () => {
    for (const v of [null, undefined, "", "  ", "abc", "N/A", "na", "none", "TBD", "-"]) expect(normaliseSerial(v)).toBeNull();
  });
});

describe("findPossibleDuplicates", () => {
  const assets = [
    { id: "a", name: "Pkg 1", serial_number: "HVF00117", model: "DPA1321R3-IA" },
    { id: "b", name: "Duct 1", serial_number: "FSF02371", model: "DSA361R1-OA" },
    { id: "c", name: "Duct 2", serial_number: null, model: "DSA361R1-OA" },
    { id: "d", name: "Duct 3", serial_number: "LUF05380", model: "DSA361R1-OA" },
  ];
  it("finds the asset with the same serial", () => {
    const r = findPossibleDuplicates({ serial: "hvf00117", model: "DPA1321R3-IA" }, assets);
    expect(r.sameSerial.map((a) => a.id)).toEqual(["a"]);
    expect(r.sameModel).toEqual([]);
  });
  it("offers same-model assets with no serial, but not ones whose serial proves they differ", () => {
    const r = findPossibleDuplicates({ serial: "HSF03069", model: "dsa361r1-oa" }, assets);
    expect(r.sameSerial).toEqual([]);
    expect(r.sameModel.map((a) => a.id)).toEqual(["c"]);
  });
  it("offers every same-model asset when the unit has no serial", () => {
    const r = findPossibleDuplicates({ serial: null, model: "DSA361R1-OA" }, assets);
    expect(r.sameModel.map((a) => a.id).sort()).toEqual(["b", "c", "d"]);
  });
  it("leaves out assets already matched to another unit", () => {
    const r = findPossibleDuplicates({ serial: null, model: "DSA361R1-OA" }, assets, new Set(["b", "c"]));
    expect(r.sameModel.map((a) => a.id)).toEqual(["d"]);
  });
  it("finds nothing for a unit with neither serial nor model", () => {
    expect(findPossibleDuplicates({ serial: null, model: null }, assets)).toEqual({ sameSerial: [], sameModel: [] });
  });
});

import { describeUnitMismatch, parseTonnage } from "../asset-duplicates";
import { datesOverlap } from "../procurement/amc-overlap";

describe("parseTonnage", () => {
  it("reads TR and tons written in several ways", () => {
    expect(parseTonnage("Ducted ODU 3.00 TR")).toBe(3);
    expect(parseTonnage("11TR package")).toBe(11);
    expect(parseTonnage("1.5 ton split")).toBe(1.5);
  });
  it("returns null when none is written, and ignores unrelated numbers", () => {
    expect(parseTonnage("AMC Test HVAC Unit 2", null, undefined)).toBeNull();
    expect(parseTonnage("Cabin 3 AC")).toBeNull();
  });
  it("takes the first text that has one", () => {
    expect(parseTonnage("Unit", "5.5 TR", "9 TR")).toBe(5.5);
  });
});

describe("describeUnitMismatch", () => {
  const unit = { serial: "DSA361R1-OAFSF02371", model: "DSA361R1-OA", capacity: "3.00 TR" };
  it("says nothing for the right asset", () => {
    expect(describeUnitMismatch(unit, { name: "Ducted 3 TR", model: "DSA361R1-OA", serial_number: "FSF02371" })).toEqual([]);
  });
  it("warns when the capacity written on the asset differs", () => {
    expect(describeUnitMismatch(unit, { name: "Package unit 11 TR" })).toEqual(["it looks like a 11 TR unit, but the proposal unit is 3 TR"]);
  });
  it("warns on a different serial or model", () => {
    const r = describeUnitMismatch(unit, { name: "AC", model: "DPA1321R3-IA", serial_number: "HVF00117" });
    expect(r).toHaveLength(2);
    expect(r[0]).toMatch(/serial number is HVF00117/);
    expect(r[1]).toMatch(/model is DPA1321R3-IA/);
  });
  it("stays quiet when the asset has no serial, model or capacity to compare", () => {
    expect(describeUnitMismatch(unit, { name: "AMC Test HVAC Unit 1" })).toEqual([]);
    expect(describeUnitMismatch({ serial: null, model: null, capacity: null }, { name: "11 TR", model: "X", serial_number: "ABCD1234" })).toEqual([]);
  });
});

describe("datesOverlap", () => {
  it("finds shared days, including a single shared day", () => {
    expect(datesOverlap("2026-04-01", "2027-03-31", "2026-12-01", "2027-11-30")).toBe(true);
    expect(datesOverlap("2026-04-01", "2026-06-30", "2026-06-30", "2026-09-30")).toBe(true);
  });
  it("does not flag back-to-back contracts", () => {
    expect(datesOverlap("2026-04-01", "2027-03-31", "2027-04-01", "2028-03-31")).toBe(false);
  });
});

import { assetDetail, matchScore, rankAssetsForUnit } from "../asset-duplicates";

describe("rankAssetsForUnit", () => {
  const unit = { serial: "DSA361R1-OAFSF02371", model: "DSA361R1-OA", capacity: "3.00 TR" };
  const hvac = { category: { slug: "hvac", name: "HVAC" } };
  const assets = [
    { id: "chair", name: "TEST chair", category: { slug: "furn", name: "Furniture" } },
    { id: "pkg", name: "Package 11 TR", model: "DPA1321R3-IA", ...hvac },
    { id: "same-model", name: "Duct 2", model: "DSA361R1-OA", ...hvac },
    { id: "exact", name: "Duct 1", model: "DSA361R1-OA", serial_number: "FSF02371", ...hvac },
    { id: "cap", name: "Spare 3 TR", ...hvac },
  ];
  it("puts the serial match first, then model, then capacity, then other air-conditioning assets", () => {
    expect(rankAssetsForUnit(unit, assets).map((r) => r.asset.id)).toEqual(["exact", "same-model", "cap", "pkg", "chair"]);
  });
  it("keeps every asset and the original order for ties", () => {
    const plain = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    expect(rankAssetsForUnit(unit, plain).map((r) => r.asset.id)).toEqual(["a", "b"]);
    expect(matchScore(unit, plain[0])).toBe(0);
  });
});

describe("assetDetail", () => {
  it("joins model, serial and capacity, leaving out what is unknown", () => {
    expect(assetDetail({ id: "x", name: "Duct 3 TR", model: "DSA361R1-OA", serial_number: "FSF02371" })).toBe("DSA361R1-OA · Serial FSF02371 · 3 TR");
    expect(assetDetail({ id: "x", name: "Unit 1" })).toBe("");
  });
});

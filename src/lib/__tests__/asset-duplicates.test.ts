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

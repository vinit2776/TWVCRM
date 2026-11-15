import { describe, expect, it } from "vitest";
import {
  looksMaskedAadhaar,
  maskAadhaar,
  redactCaseChanges,
  redactCaseSecrets,
} from "@/lib/case-pii";
import { createCaseSchema, updateCaseSchema } from "@/lib/validations";

describe("maskAadhaar", () => {
  it("keeps only the last four digits", () => {
    expect(maskAadhaar("234567891234")).toBe("XXXX XXXX 1234");
    expect(maskAadhaar("2345 6789 1234")).toBe("XXXX XXXX 1234");
  });
  it("fully masks anything unusable", () => {
    expect(maskAadhaar("12")).toBe("XXXX XXXX XXXX");
    expect(maskAadhaar("abc")).toBe("XXXX XXXX XXXX");
  });
});

describe("redactCaseSecrets", () => {
  it("masks an Aadhaar and leaves the input untouched", () => {
    const row = { represented_by_id_type: "aadhaar", represented_by_id_number: "234567891234" };
    expect(redactCaseSecrets(row).represented_by_id_number).toBe("XXXX XXXX 1234");
    expect(row.represented_by_id_number).toBe("234567891234");
  });
  it("leaves a PAN alone", () => {
    const row = { represented_by_id_type: "pan", represented_by_id_number: "ABCDE1234F" };
    expect(redactCaseSecrets(row)).toBe(row);
  });
  it("uses the override type when the record lacks one", () => {
    const out = redactCaseSecrets({ represented_by_id_number: "234567891234" }, "aadhaar");
    expect(out.represented_by_id_number).toBe("XXXX XXXX 1234");
  });
});

describe("redactCaseChanges", () => {
  it("masks both sides of the diff for an Aadhaar", () => {
    const out = redactCaseChanges(
      { represented_by_id_number: { old: "234567891234", new: "987654321098" }, client_name: { old: "a", new: "b" } },
      "aadhaar"
    );
    expect(out.represented_by_id_number).toEqual({ old: "XXXX XXXX 1234", new: "XXXX XXXX 1098" });
    expect(out.client_name).toEqual({ old: "a", new: "b" });
  });
  it("does not touch a PAN diff", () => {
    const changes = { represented_by_id_number: { old: "ABCDE1234F", new: "ZZZZZ9999Z" } };
    expect(redactCaseChanges(changes, "pan")).toBe(changes);
  });
});

describe("masked value guard", () => {
  it("recognises masked text", () => {
    expect(looksMaskedAadhaar("XXXX XXXX 1234")).toBe(true);
    expect(looksMaskedAadhaar("xxxxxxxx1234")).toBe(true);
    expect(looksMaskedAadhaar("234567891234")).toBe(false);
    expect(looksMaskedAadhaar("ABCDX1234F")).toBe(false);
  });
  it("rejects a masked number on update but accepts real ones", () => {
    expect(updateCaseSchema.safeParse({ represented_by_id_number: "XXXX XXXX 1234" }).success).toBe(false);
    expect(updateCaseSchema.safeParse({ represented_by_id_number: "234567891234" }).success).toBe(true);
    expect(updateCaseSchema.safeParse({ client_name: "x" }).success).toBe(true);
  });
  it("rejects it on create too", () => {
    const r = createCaseSchema.safeParse({
      client_name: "x",
      client_entity_type: "individual",
      purpose: "gst_registration",
      represented_by_id_number: "XXXX XXXX 1234",
    });
    expect(r.success).toBe(false);
  });
});

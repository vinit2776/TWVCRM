import { describe, it, expect } from "vitest";
import {
  extractJsonFromResponse,
  validateParsedResponse,
  normalizeParsedCaseData,
} from "../email-parser";

describe("extractJsonFromResponse", () => {
  it("parses a bare JSON object", () => {
    const raw = extractJsonFromResponse('{"client_name": "Acme Pvt Ltd"}');
    expect(raw).toEqual({ client_name: "Acme Pvt Ltd" });
  });

  it("parses JSON wrapped in a ```json markdown code fence", () => {
    const text = '```json\n{"client_name": "Acme Pvt Ltd"}\n```';
    const raw = extractJsonFromResponse(text);
    expect(raw).toEqual({ client_name: "Acme Pvt Ltd" });
  });

  it("parses JSON wrapped in a bare ``` code fence (no language tag)", () => {
    const text = '```\n{"client_name": "Acme Pvt Ltd"}\n```';
    const raw = extractJsonFromResponse(text);
    expect(raw).toEqual({ client_name: "Acme Pvt Ltd" });
  });

  it("extracts JSON surrounded by extra prose the model added", () => {
    const text =
      'Here is the extracted data:\n{"client_name": "Acme Pvt Ltd"}\nLet me know if you need anything else.';
    const raw = extractJsonFromResponse(text);
    expect(raw).toEqual({ client_name: "Acme Pvt Ltd" });
  });

  it("throws when the response has no JSON object at all", () => {
    expect(() => extractJsonFromResponse("Sorry, I could not extract any data.")).toThrow(
      "Could not parse AI response as JSON"
    );
  });

  it("throws when the response is empty", () => {
    expect(() => extractJsonFromResponse("")).toThrow(
      "Could not parse AI response as JSON"
    );
  });

  it("throws when braces are present but reversed (no valid object span)", () => {
    expect(() => extractJsonFromResponse("} some text {")).toThrow();
  });

  it("throws when the code fence contains invalid JSON", () => {
    expect(() =>
      extractJsonFromResponse('```json\n{client_name: "Acme"}\n```')
    ).toThrow();
  });
});

describe("validateParsedResponse", () => {
  it("accepts a well-formed extraction object", () => {
    const validated = validateParsedResponse({
      client_name: "Acme Pvt Ltd",
      client_entity_type: "pvt_ltd",
      purpose: "gst_registration",
      confidence: 0.9,
      missing_fields: [],
    });
    expect(validated.client_name).toBe("Acme Pvt Ltd");
  });

  it("accepts numeric-typed string fields (model returns rate as a string)", () => {
    const validated = validateParsedResponse({
      client_name: "Acme",
      rate: "50000",
      tenure_months: "12",
    });
    expect(validated.rate).toBe("50000");
  });

  it("preserves unrecognized extra fields via passthrough", () => {
    const validated = validateParsedResponse({
      client_name: "Acme",
      some_field_the_model_invented: "extra",
    });
    expect(validated.some_field_the_model_invented).toBe("extra");
  });

  it("rejects a top-level JSON array", () => {
    expect(() => validateParsedResponse([1, 2, 3])).toThrow(
      "AI response failed validation"
    );
  });

  it("rejects a top-level scalar", () => {
    expect(() => validateParsedResponse("just a string")).toThrow(
      "AI response failed validation"
    );
  });

  it("rejects null", () => {
    expect(() => validateParsedResponse(null)).toThrow(
      "AI response failed validation"
    );
  });

  it("rejects a field of an unexpected type (object instead of string)", () => {
    expect(() =>
      validateParsedResponse({
        client_name: { first: "A", last: "B" },
      })
    ).toThrow("AI response failed validation");
  });

  it("rejects missing_fields when it is not an array", () => {
    expect(() =>
      validateParsedResponse({
        client_name: "Acme",
        missing_fields: "client_email",
      })
    ).toThrow("AI response failed validation");
  });
});

describe("normalizeParsedCaseData — falsy-zero confidence bug", () => {
  it("preserves a legitimate confidence of 0 instead of defaulting to 0.5", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      confidence: 0,
    });
    expect(result.confidence).toBe(0);
  });

  it("defaults to 0.5 when confidence is missing entirely", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
    });
    expect(result.confidence).toBe(0.5);
  });

  it("defaults to 0.5 when confidence is a non-numeric string", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      confidence: "unsure",
    });
    expect(result.confidence).toBe(0.5);
  });

  it("preserves a normal mid-range confidence value", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      confidence: 0.85,
    });
    expect(result.confidence).toBe(0.85);
  });

  it("coerces a numeric-string confidence", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      confidence: "0.72",
    });
    expect(result.confidence).toBe(0.72);
  });
});

describe("normalizeParsedCaseData — field coercion and defaults", () => {
  it("defaults client_name to 'Unknown' when missing", () => {
    const result = normalizeParsedCaseData({});
    expect(result.client_name).toBe("Unknown");
  });

  it("falls back to 'other' for an unrecognized client_entity_type", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      client_entity_type: "sole_trader_llc", // not a valid EntityType
    });
    expect(result.client_entity_type).toBe("other");
  });

  it("falls back to 'business_address' for an unrecognized purpose", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      purpose: "something_unexpected",
    });
    expect(result.purpose).toBe("business_address");
  });

  it("passes through a valid entity_type and purpose unchanged", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      client_entity_type: "llp",
      purpose: "mca_registration",
    });
    expect(result.client_entity_type).toBe("llp");
    expect(result.purpose).toBe("mca_registration");
  });

  it("defaults missing_fields to an empty array when absent or malformed", () => {
    const result = normalizeParsedCaseData({ client_name: "Acme" });
    expect(result.missing_fields).toEqual([]);
  });

  it("stringifies missing_fields entries", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      missing_fields: ["client_email", "client_phone"],
    });
    expect(result.missing_fields).toEqual(["client_email", "client_phone"]);
  });

  it("omits optional fields that were not present in the source", () => {
    const result = normalizeParsedCaseData({ client_name: "Acme" });
    expect(result.rate).toBeUndefined();
    expect(result.client_email).toBeUndefined();
  });

  it("coerces rate and tenure_months to numbers when present as strings", () => {
    const result = normalizeParsedCaseData({
      client_name: "Acme",
      rate: "50000",
      tenure_months: "12",
    });
    expect(result.rate).toBe(50000);
    expect(result.tenure_months).toBe(12);
  });

  it("retains the full validated object as raw_extraction", () => {
    const source = { client_name: "Acme", weird_extra_field: "x" };
    const result = normalizeParsedCaseData(source);
    expect(result.raw_extraction).toBe(source);
  });
});

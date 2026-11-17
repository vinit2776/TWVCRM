import { describe, it, expect } from "vitest";
import { createCaseSchema } from "../validations";

// The first location was seeded by migration 00006 with this hand-written id.
const DEFAULT_LOCATION_ID = "00000000-0000-0000-0000-000000000001";

const baseCase = {
  case_source: "direct" as const,
  purpose: "business_address" as const,
  client_name: "Test Client",
  client_entity_type: "pvt_ltd" as const,
  rate: 2500,
};

describe("case location_id", () => {
  it("accepts the default location's id", () => {
    const r = createCaseSchema.safeParse({ ...baseCase, location_id: DEFAULT_LOCATION_ID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.location_id).toBe(DEFAULT_LOCATION_ID);
  });
  it("accepts a generated id and treats blank as not set", () => {
    expect(createCaseSchema.safeParse({ ...baseCase, location_id: "390cf176-08b7-4c43-9be7-33ce20b6c9f2" }).success).toBe(true);
    const blank = createCaseSchema.safeParse({ ...baseCase, location_id: "" });
    expect(blank.success && blank.data.location_id).toBe(undefined);
  });
  it("still rejects a value that is not id-shaped", () => {
    expect(createCaseSchema.safeParse({ ...baseCase, location_id: "default-center" }).success).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { electricityConfigForRenewal } from "../electricity-renewal";

describe("electricityConfigForRenewal", () => {
  const parent = {
    id: "cfg-1",
    contract_id: "old",
    location_id: "loc-1",
    enabled: true,
    utility_ratio: 80,
    generator_ratio: 20,
    customer_gst_rate: 18,
    billing_profile_id: "profile-1",
    created_at: "2026-01-01",
    updated_at: "2026-02-01",
  };

  it("keeps every setting and points at the renewal", () => {
    const out = electricityConfigForRenewal(parent, "new");
    expect(out).toMatchObject({
      contract_id: "new",
      location_id: "loc-1",
      enabled: true,
      utility_ratio: 80,
      generator_ratio: 20,
      customer_gst_rate: 18,
      billing_profile_id: "profile-1",
    });
  });

  it("drops the row identity and timestamps", () => {
    const out = electricityConfigForRenewal(parent, "new");
    expect(out).not.toHaveProperty("id");
    expect(out).not.toHaveProperty("created_at");
    expect(out).not.toHaveProperty("updated_at");
  });

  it("does not mutate the source row", () => {
    electricityConfigForRenewal(parent, "new");
    expect(parent.contract_id).toBe("old");
  });
});

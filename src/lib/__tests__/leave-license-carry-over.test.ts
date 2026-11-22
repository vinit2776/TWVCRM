import { describe, it, expect } from "vitest";
import { carryOverLeaveLicenseVariables } from "@/lib/leave-license-carry-over";

const fresh = {
  agreement_date: "20 Nov 2026",
  agreement_number: "",
  client_name: "Case Name",
  client_address: "New case address",
  location_address: "New office address",
  rate: 1000,
  nature_of_business: "To be provided",
};

describe("carryOverLeaveLicenseVariables", () => {
  it("returns the fresh variables for a first generation", () => {
    expect(carryOverLeaveLicenseVariables(fresh, null)).toEqual(fresh);
    expect(carryOverLeaveLicenseVariables(fresh, undefined)).toEqual(fresh);
  });

  it("keeps every typed value, including ones the case does not hold", () => {
    const out = carryOverLeaveLicenseVariables(fresh, {
      client_name: "Edited Name",
      rate: 1200,
      nature_of_business: "Trading of garments",
      witness_1_name: "Asha",
      estamp_value: 300,
    });
    expect(out.client_name).toBe("Edited Name");
    expect(out.rate).toBe(1200);
    expect(out.nature_of_business).toBe("Trading of garments");
    expect((out as Record<string, unknown>).witness_1_name).toBe("Asha");
    expect((out as Record<string, unknown>).estamp_value).toBe(300);
  });

  it("does not carry the agreement date, number or reset markers", () => {
    const out = carryOverLeaveLicenseVariables(fresh, {
      agreement_date: "1 Jan 2026",
      agreement_number: "OLD-1",
      address_reset_at: "2026-11-01",
      address_reset_reason: "moved",
    }) as Record<string, unknown>;
    expect(out.agreement_date).toBe("20 Nov 2026");
    expect(out.agreement_number).toBe("");
    expect(out.address_reset_at).toBeUndefined();
    expect(out.address_reset_reason).toBeUndefined();
  });

  it("takes the address from the case when it moved since the last generation", () => {
    const out = carryOverLeaveLicenseVariables(fresh, {
      client_address: "Old address",
      location_address: "Old office",
      address_reset_at: "2026-11-01",
      client_name: "Edited Name",
    });
    expect(out.client_address).toBe("New case address");
    expect(out.location_address).toBe("New office address");
    expect(out.client_name).toBe("Edited Name");
  });

  it("keeps an edited address when the case address has not moved", () => {
    const out = carryOverLeaveLicenseVariables(fresh, { client_address: "Typed address" });
    expect(out.client_address).toBe("Typed address");
  });
});

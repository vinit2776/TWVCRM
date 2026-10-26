import { describe, it, expect } from "vitest";
import { computeSetupChecks, summariseSetup, type SetupInput } from "@/lib/electricity-setup-checks";

const good: SetupInput = {
  config: { enabled: true, landlord_vendor_id: "v1", landlord_utility_pct: 90, landlord_generator_pct: 10 },
  landlordVendorName: "Landlord Co",
  activeConnections: 1,
  contracts: [{ contract_id: "c1", contract_number: "TWV-C-0028", enabled: true, status: "active", billing_profile_id: "p1", profile_active: true }],
  autoApproveEnabled: true,
};
const byKey = (i: SetupInput) => Object.fromEntries(computeSetupChecks(i).map((c) => [c.key, c]));

describe("computeSetupChecks", () => {
  it("is all green when everything is in place", () => {
    const checks = computeSetupChecks(good);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(summariseSetup(checks)).toEqual({ missingRequired: 0, missingRecommended: 0 });
  });

  it("flags a missing landlord as required and says what is lost", () => {
    const k = byKey({ ...good, config: { ...good.config!, landlord_vendor_id: null } });
    expect(k.landlord_vendor.ok).toBe(false);
    expect(k.landlord_vendor.level).toBe("required");
    expect(k.landlord_vendor.detail).toMatch(/no payable/i);
  });

  it("treats a location with no config row as not switched on", () => {
    const k = byKey({ ...good, config: null });
    expect(k.enabled.ok).toBe(false);
    expect(k.landlord_vendor.ok).toBe(false);
    expect(k.landlord_split.ok).toBe(false);
  });

  it("rejects a split that does not add to 100", () => {
    const k = byKey({ ...good, config: { ...good.config!, landlord_utility_pct: 90, landlord_generator_pct: 20 } });
    expect(k.landlord_split.ok).toBe(false);
  });

  it("flags no billed contract, and offers the location's live contracts to open", () => {
    const k = byKey({ ...good, contracts: [{ ...good.contracts[0], enabled: false }] });
    expect(k.contract_billed.ok).toBe(false);
    expect(k.contract_billed.contracts).toEqual([{ id: "c1", number: "TWV-C-0028" }]);
    expect(k.billing_profile).toBeUndefined();
  });

  it("ignores contracts that are not active or in renewal", () => {
    const k = byKey({ ...good, contracts: [{ ...good.contracts[0], status: "terminated" }] });
    expect(k.contract_billed.ok).toBe(false);
    expect(k.contract_billed.contracts).toEqual([]);
  });

  it("flags a billed contract with no active profile and names it", () => {
    const k = byKey({ ...good, contracts: [{ ...good.contracts[0], billing_profile_id: "p1", profile_active: false }] });
    expect(k.billing_profile.ok).toBe(false);
    expect(k.billing_profile.detail).toMatch(/TWV-C-0028/);
    expect(k.billing_profile.contracts).toEqual([{ id: "c1", number: "TWV-C-0028" }]);
  });

  it("counts a missing connection as recommended, not required", () => {
    const checks = computeSetupChecks({ ...good, activeConnections: 0 });
    expect(summariseSetup(checks)).toEqual({ missingRequired: 0, missingRecommended: 1 });
  });

  it("explains when auto-approve is switched off", () => {
    expect(byKey({ ...good, autoApproveEnabled: false }).auto_approve.detail).toMatch(/by hand/);
  });
});

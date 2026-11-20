import { describe, it, expect } from "vitest";
import { leaveLicenseCarryOver } from "@/lib/leave-license-carry-over";

describe("leaveLicenseCarryOver", () => {
  it("returns nothing for a first generation", () => {
    expect(leaveLicenseCarryOver(null)).toEqual({});
    expect(leaveLicenseCarryOver(undefined)).toEqual({});
  });

  it("keeps the fields only a person types into the agreement", () => {
    const out = leaveLicenseCarryOver({
      nature_of_business: " Trading of garments ",
      witness_1_name: "Asha",
      witness_1_aadhaar_last4: "1234",
      witness_1_mobile: "9876543210",
      witness_2_name: "Ravi",
      estamp_value: 300,
      lessee_signatory_name: "Priya",
      lessee_signatory_designation: "Director",
    });
    expect(out.natureOfBusiness).toBe("Trading of garments");
    expect(out.witness1Name).toBe("Asha");
    expect(out.witness1AadhaarLast4).toBe("1234");
    expect(out.witness2Name).toBe("Ravi");
    expect(out.estampValue).toBe(300);
    expect(out.lesseeSignatoryName).toBe("Priya");
    expect(out.lesseeSignatoryDesignation).toBe("Director");
  });

  it("drops the generator's own placeholders so they are not treated as edits", () => {
    const out = leaveLicenseCarryOver({
      nature_of_business: "To be provided",
      lessee_signatory_designation: "Authorized Signatory",
      witness_1_name: "",
      estamp_value: 0,
    });
    expect(out.natureOfBusiness).toBeUndefined();
    expect(out.lesseeSignatoryDesignation).toBeUndefined();
    expect(out.witness1Name).toBeUndefined();
    expect(out.estampValue).toBeUndefined();
  });
});

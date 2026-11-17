import { describe, it, expect } from "vitest";
import {
  legacyPurposeFor,
  toCurrentPurpose,
  purposeNeedsGstPlace,
  isPrincipalGstPurpose,
  isAdditionalGstPurpose,
  isNewGstPurpose,
  isMissingEnumValueError,
} from "@/lib/vo-purpose";
import { VO_PURPOSES, VO_PURPOSE_LABELS, VO_PURPOSE_COLORS, DOCUMENT_CHECKLISTS, COMPLIANCE_CHECKLISTS } from "@/lib/constants";
import { generateDocumentChecklist, generateComplianceChecklist } from "@/lib/compliance";
import { getTemplateKey } from "@/lib/agreement-generator";

describe("legacy mapping", () => {
  it("maps legacy gst values onto the new ones only where unambiguous", () => {
    expect(toCurrentPurpose("gst_registration")).toBe("gst_new");
    expect(toCurrentPurpose("branch_office")).toBe("gst_existing");
    for (const p of ["mca_registration", "mail_handling", "business_address", "gst_new"]) {
      expect(toCurrentPurpose(p)).toBe(p);
    }
  });

  it("resolves new values to the legacy counterpart and leaves everything else alone", () => {
    expect(legacyPurposeFor("gst_new")).toBe("gst_registration");
    expect(legacyPurposeFor("gst_existing")).toBe("branch_office");
    expect(legacyPurposeFor("gst_registration")).toBe("gst_registration");
    expect(legacyPurposeFor("mail_handling")).toBe("mail_handling");
    expect(legacyPurposeFor("something_else")).toBe("something_else");
  });
});

describe("GST place helpers", () => {
  it("lists purposes that need a GST place", () => {
    const needing = VO_PURPOSES.filter((p) => purposeNeedsGstPlace(p));
    expect(needing.sort()).toEqual(["branch_office", "gst_existing", "gst_new", "gst_registration"]);
    expect(purposeNeedsGstPlace(null)).toBe(false);
  });
  it("classifies principal versus additional", () => {
    expect(isPrincipalGstPurpose("gst_new")).toBe(true);
    expect(isPrincipalGstPurpose("gst_registration")).toBe(true);
    expect(isAdditionalGstPurpose("gst_existing")).toBe(true);
    expect(isAdditionalGstPurpose("branch_office")).toBe(true);
    expect(isPrincipalGstPurpose("gst_existing")).toBe(false);
    expect(isNewGstPurpose("gst_new")).toBe(true);
    expect(isNewGstPurpose("gst_registration")).toBe(false);
  });
});

describe("new values behave like their legacy counterparts", () => {
  it("has a label and colour for every purpose", () => {
    for (const p of VO_PURPOSES) {
      expect(VO_PURPOSE_LABELS[p]).toBeTruthy();
      expect(VO_PURPOSE_COLORS[p]).toBeTruthy();
    }
    expect(VO_PURPOSES).toContain("gst_registration");
  });
  it("reuses KYC checklists", () => {
    expect(generateDocumentChecklist("gst_new", "pvt_ltd")).toEqual(DOCUMENT_CHECKLISTS.gst_registration.pvt_ltd);
    expect(generateDocumentChecklist("gst_existing", "pvt_ltd")).toEqual(DOCUMENT_CHECKLISTS.branch_office.pvt_ltd);
    expect(generateComplianceChecklist("gst_new")).toEqual(COMPLIANCE_CHECKLISTS.gst_registration);
    expect(generateComplianceChecklist("gst_existing")).toEqual(COMPLIANCE_CHECKLISTS.branch_office);
  });
  it("reuses agreement templates", () => {
    expect(getTemplateKey("gst_new")).toBe("vo_gst_registration");
    expect(getTemplateKey("gst_existing")).toBe("vo_branch_office");
    expect(getTemplateKey("gst_registration")).toBe("vo_gst_registration");
  });
});

describe("isMissingEnumValueError", () => {
  it("matches only 22P02", () => {
    expect(isMissingEnumValueError({ code: "22P02" })).toBe(true);
    expect(isMissingEnumValueError({ code: "23505" })).toBe(false);
    expect(isMissingEnumValueError(null)).toBe(false);
  });
});

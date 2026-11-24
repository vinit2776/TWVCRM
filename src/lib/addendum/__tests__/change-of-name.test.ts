import { describe, expect, it } from "vitest";
import {
  applyChanges, buildChangeOfNameText, canApproveAddendum, canAuthorAddendum, canSealAddendum, contextWarnings, checklistFor,
  findPlaceholders, signatureBlocks, isEditable, validateParams, type ChangeOfNameParams,
} from "../change-of-name";

const base: ChangeOfNameParams = {
  kind: "new_entity",
  newName: "Sample Customer Private Limited", entityType: "pvt_ltd", gstin: "33AAAAA0000A1Z5", pan: "AAAAA0000A",
  cin: "U00000TN2026PTC000000", registeredAddress: "1 Test Road, Chennai", signatoryName: "A Director",
  signatoryDesignation: "Director", effectiveDate: "2026-12-01", depositCarriesOver: true,
  companyTakesEarlierDues: false, outgoingName: "Mr Sample", outgoingAddress: "2 Test Road", agreementDate: "2026-06-14", commencementDate: "2026-07-01",
  contractNumber: "TWV-C-0125",
};

describe("validateParams", () => {
  it("accepts a complete set", () => expect(validateParams(base)).toEqual([]));
  it("requires name, date and signatory", () => {
    expect(validateParams({}).length).toBe(3);
  });
  it("rejects a malformed GSTIN or PAN but allows them blank", () => {
    expect(validateParams({ ...base, gstin: "123" })).toHaveLength(1);
    expect(validateParams({ ...base, pan: "123" })).toHaveLength(1);
    expect(validateParams({ ...base, gstin: "", pan: "" })).toEqual([]);
  });
});

describe("buildChangeOfNameText", () => {
  const text = buildChangeOfNameText(base, 1);
  it("cites the agreement date and the commencement date", () => {
    expect(text).toContain("dated 14 June 2026");
    expect(text).toContain("Commencement Date of 1 July 2026");
  });
  it("names all three parties and the effective date", () => {
    expect(text).toContain("SREE DESIGN INFRASTRUCTURE PRIVATE LIMITED");
    expect(text).toContain("Mr Sample");
    expect(text).toContain("Sample Customer Private Limited");
    expect(text).toContain("1 December 2026");
    expect(text).toContain("GSTIN 33AAAAA0000A1Z5");
  });
  it("leaves commercial terms alone and invents nothing", () => {
    expect(text).toContain("commercial terms are unchanged");
    expect(text).not.toMatch(/penalty|interest|indemn/i);
  });
  it("follows the deposit and dues answers", () => {
    expect(text).toContain("held for the Incoming Member");
    expect(text).toContain("The Outgoing Member remains responsible");
    const flipped = buildChangeOfNameText({ ...base, depositCarriesOver: false, companyTakesEarlierDues: true }, 2);
    expect(flipped).toContain("ADDENDUM NO. 2");
    expect(flipped).toContain("takes over, and shall pay");
    expect(flipped).not.toContain("held for the Incoming Member");
  });
  it("leaves bracketed placeholders for what is unknown", () => {
    const t = buildChangeOfNameText({ ...base, registeredAddress: "", outgoingAddress: "" }, 1);
    expect(findPlaceholders(t)).toEqual(expect.arrayContaining(["[registered address]", "[outgoing member's address]", "[date of signing]"]));
  });
});

describe("roles and edit rule", () => {
  it("lets sales author but not approve, and only admin seal", () => {
    expect(canAuthorAddendum("sales_rep")).toBe(true);
    expect(canApproveAddendum("sales_rep")).toBe(false);
    expect(canApproveAddendum("manager")).toBe(true);
    expect(canSealAddendum("manager")).toBe(false);
    expect(canSealAddendum("admin")).toBe(true);
  });
  it("edits only before approval", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("changes_requested")).toBe(true);
    expect(isEditable("approved")).toBe(false);
  });
});

describe("applyChanges", () => {
  it("lists only fields that change and keeps old values when blank", () => {
    const { next, rows } = applyChanges({ ...base, gstin: "" }, { company: null, gst_number: "OLDGST", pan_number: "ABCDE1234F", entity_type: "individual" });
    expect(next.gst_number).toBe("OLDGST");
    expect(rows.map((r) => r.field).sort()).toEqual(["company", "entity_type", "pan_number"]);
  });
});

const rename: ChangeOfNameParams = { ...base, kind: "same_entity", outgoingName: "Old Widgets Pvt Ltd", newName: "New Widgets Pvt Ltd" };

describe("same entity renamed", () => {
  const text = buildChangeOfNameText(rename, 1);
  it("says the same legal person, assigns nothing and releases nothing", () => {
    expect(text).toContain("formerly known as Old Widgets Pvt Ltd");
    expect(text).toContain("same legal person");
    expect(text).toContain("continue as before");
    expect(text).not.toMatch(/Outgoing Member|Incoming Member|takes on all rights/);
  });
  it("is shorter than a takeover and has two signature blocks", () => {
    expect(text.length).toBeLessThan(buildChangeOfNameText(base, 1).length);
    expect(signatureBlocks(rename).map((b) => b.role)).toEqual(["Member", "For TWV"]);
    expect(signatureBlocks(base).map((b) => b.role)).toEqual(["Outgoing Member", "Incoming Member", "For TWV"]);
  });
  it("keeps the entity type on the record when applied", () => {
    const { next } = applyChanges(rename, { company: "Old Widgets Pvt Ltd", gst_number: null, pan_number: null, entity_type: "pvt_ltd" });
    expect(next.entity_type).toBe("pvt_ltd");
  });
});

describe("contextWarnings", () => {
  it("flags a different PAN on a rename, and the same PAN on a takeover", () => {
    expect(contextWarnings("same_entity", "AAAAA0000A", "ABCDE1234F", "pvt_ltd", "pvt_ltd")).toHaveLength(1);
    expect(contextWarnings("new_entity", "ABCDE1234F", "abcde1234f", "pvt_ltd", "individual")).toHaveLength(1);
  });
  it("flags an entity-type change on a rename", () => {
    expect(contextWarnings("same_entity", "", "", "pvt_ltd", "individual")).toHaveLength(1);
  });
  it("stays quiet when nothing contradicts the choice", () => {
    expect(contextWarnings("same_entity", "ABCDE1234F", "ABCDE1234F", "pvt_ltd", "pvt_ltd")).toEqual([]);
    expect(contextWarnings("new_entity", "AAAAA0000A", "ABCDE1234F", "pvt_ltd", "individual")).toEqual([]);
  });
});

describe("entity-to-entity takeover", () => {
  const eToE: ChangeOfNameParams = { ...base, outgoingIsEntity: true, outgoingName: "Old Widgets LLP", outgoingSignatoryName: "A Partner", outgoingSignatoryDesignation: "Designated Partner", entityType: "pvt_ltd" };
  it("names the outgoing entity and who signs for it", () => {
    const t = buildChangeOfNameText(eToE, 1);
    expect(t).toContain("Old Widgets LLP");
    expect(t).toContain("represented by A Partner, Designated Partner");
    expect(t).toContain("taken over by the Incoming Member");
    expect(signatureBlocks(eToE)[0].name).toBe("Old Widgets LLP, by A Partner");
  });
  it("needs a signatory for the outgoing entity, and asks for its authority papers", () => {
    expect(validateParams({ ...eToE, outgoingSignatoryName: "" })).toHaveLength(1);
    expect(checklistFor("new_entity", true)).toHaveLength(checklistFor("new_entity", false).length + 1);
  });
  it("an individual becoming any entity carries on the business", () => {
    expect(buildChangeOfNameText({ ...base, entityType: "llp" }, 1)).toContain("carry on the Outgoing Member's business");
  });
  it("uses an address, not a registered office, for a partnership", () => {
    expect(buildChangeOfNameText({ ...base, entityType: "partnership" }, 1)).toContain("having its address at");
    expect(buildChangeOfNameText({ ...base, entityType: "llp" }, 1)).toContain("registered office at");
  });
});

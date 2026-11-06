import { describe, it, expect, vi, beforeEach } from "vitest";

const writeAgreementPdf = vi.fn();
const cancelSigningRequest = vi.fn();
vi.mock("@/lib/special-clause/case-regenerate", () => ({ writeAgreementPdf: (...a: unknown[]) => writeAgreementPdf(...a) }));
vi.mock("@/lib/leegality", () => ({ cancelSigningRequest: (...a: unknown[]) => cancelSigningRequest(...a) }));

import { resetAgreementsForNewAddress, cancelOpenSigningRequests, type SignedAgreementRow } from "../agreement-reset";

const row = (over: Partial<SignedAgreementRow> = {}): SignedAgreementRow => ({
  id: "a1", type: "leave_license", template_key: "leave_license", status: "executed",
  variables: { client_name: "X", client_address: "old" },
  generated_document_id: "gen1", signed_document_id: "signed1", leegality_document_id: "lg1", ...over,
});

function fakeAdmin() {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const admin = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };
  return { admin: admin as never, updates };
}

beforeEach(() => { writeAgreementPdf.mockReset(); cancelSigningRequest.mockReset(); });

describe("resetAgreementsForNewAddress", () => {
  it("rebuilds with the new address, chains to the signed file, clears the signature", async () => {
    writeAgreementPdf.mockResolvedValue("newdoc");
    const { admin, updates } = fakeAdmin();
    const out = await resetAgreementsForNewAddress(admin, "c1", [row()], "New, Chennai 600007", "address was missing");
    expect(out).toEqual({ reset: ["a1"], failed: [] });
    expect(writeAgreementPdf.mock.calls[0][4]).toBe("signed1"); // parent = old signed document
    expect(writeAgreementPdf.mock.calls[0][3].client_address).toBe("New, Chennai 600007");
    const agr = updates.find((u) => u.table === "case_agreements")!.values;
    expect(agr).toMatchObject({ status: "draft", signed_document_id: null, signed_at: null, leegality_document_id: null, generated_document_id: "newdoc" });
    expect(updates.find((u) => u.table === "cases")!.values).toEqual({ ll_agreement_status: "draft" });
  });

  it("falls back to the generated document as parent when nothing was uploaded as signed", async () => {
    writeAgreementPdf.mockResolvedValue("newdoc");
    const { admin } = fakeAdmin();
    await resetAgreementsForNewAddress(admin, "c1", [row({ signed_document_id: null })], "A 600007", "reason long enough");
    expect(writeAgreementPdf.mock.calls[0][4]).toBe("gen1");
  });

  it("reports a failure and leaves the agreement untouched", async () => {
    writeAgreementPdf.mockRejectedValue(new Error("upload failed"));
    const { admin, updates } = fakeAdmin();
    const out = await resetAgreementsForNewAddress(admin, "c1", [row()], "A 600007", "reason long enough");
    expect(out).toEqual({ reset: [], failed: ["a1"] });
    expect(updates).toHaveLength(0);
  });
});

describe("cancelOpenSigningRequests", () => {
  it("cancels only agreements that are mid-signature", async () => {
    cancelSigningRequest.mockResolvedValue(undefined);
    expect(await cancelOpenSigningRequests([row({ status: "executed" }), row({ id: "a2", status: "signing", leegality_document_id: "lg2" })])).toBeNull();
    expect(cancelSigningRequest).toHaveBeenCalledTimes(1);
    expect(cancelSigningRequest).toHaveBeenCalledWith("lg2");
  });
  it("returns an error message when Leegality refuses", async () => {
    cancelSigningRequest.mockRejectedValue(new Error("boom"));
    expect(await cancelOpenSigningRequests([row({ status: "signing" })])).toMatch(/nothing was changed/);
  });
});

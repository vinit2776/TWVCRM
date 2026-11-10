import { describe, it, expect, vi, beforeEach } from "vitest";

const cancelSigningRequest = vi.fn();
vi.mock("@/lib/leegality", () => ({ cancelSigningRequest: (...a: unknown[]) => cancelSigningRequest(...a) }));

import { resetAgreementsForNewAddress, cancelOpenSigningRequests, type SignedAgreementRow } from "../agreement-reset";

const row = (over: Partial<SignedAgreementRow> = {}): SignedAgreementRow => ({
  id: "a1", type: "leave_license", template_key: "leave_license", status: "executed",
  variables: { client_name: "X", client_address: "old" },
  generated_document_id: "gen1", signed_document_id: "signed1", leegality_document_id: "lg1", ...over,
});

function fakeAdmin(updateError: { message: string } | null = null) {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const admin = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { eq: () => Promise.resolve({ error: updateError }) };
      },
    }),
  };
  return { admin: admin as never, updates };
}

beforeEach(() => { cancelSigningRequest.mockReset(); });

describe("resetAgreementsForNewAddress", () => {
  it("clears the signature, keeps the old address and keeps the signed file as the draft's document", async () => {
    const { admin, updates } = fakeAdmin();
    const out = await resetAgreementsForNewAddress(admin, "c1", [row()], "address was missing");
    expect(out).toEqual({ reset: ["a1"], failed: [] });
    const agr = updates.find((u) => u.table === "case_agreements")!.values;
    expect(agr).toMatchObject({ status: "draft", signed_document_id: null, signed_at: null, leegality_document_id: null, generated_document_id: "signed1" });
    // Not rebuilt: the old address stays, which is what locks it until Regenerate.
    expect(agr.variables).toMatchObject({ client_address: "old", address_reset_reason: "address was missing" });
    expect(updates.find((u) => u.table === "cases")!.values).toEqual({ ll_agreement_status: "draft" });
  });

  it("keeps the generated document when nothing was uploaded as signed", async () => {
    const { admin, updates } = fakeAdmin();
    await resetAgreementsForNewAddress(admin, "c1", [row({ signed_document_id: null })], "reason long enough");
    expect(updates.find((u) => u.table === "case_agreements")!.values.generated_document_id).toBe("gen1");
  });

  it("reports a failure and leaves the case status untouched", async () => {
    const { admin, updates } = fakeAdmin({ message: "db down" });
    const out = await resetAgreementsForNewAddress(admin, "c1", [row()], "reason long enough");
    expect(out).toEqual({ reset: [], failed: ["a1"] });
    expect(updates.filter((u) => u.table === "cases")).toHaveLength(0);
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

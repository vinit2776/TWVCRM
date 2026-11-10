import { describe, it, expect, vi } from "vitest";

const pdf = { output: () => new ArrayBuffer(1) };
vi.mock("@/lib/agreement-generator", () => ({ generateAgreementPdf: () => pdf }));
vi.mock("@/lib/leave-license-generator", () => ({ generateLeaveLicensePdf: () => pdf }));

import { regenerateCaseAgreementPdfs } from "../special-clause/case-regenerate";

interface Row { id: string; type: string; template_key: string; status: string; variables: Record<string, unknown> }

const CASE = {
  special_clause_status: "approved", special_clause_text: "New clause",
  client_address: "9 New Road", client_city: "Chennai", client_state: "Tamil Nadu", client_pincode: "600002",
};
const NEW_ADDRESS = "9 New Road, Chennai, Tamil Nadu, 600002";

function fakeAdmin(rows: Row[]) {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  let asked: string[] = [];
  const admin = {
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: CASE }),
          in: (_col: string, statuses: string[]) => {
            asked = statuses;
            return Promise.resolve({ data: rows.filter((r) => statuses.includes(r.status)) });
          },
        }),
      }),
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "newdoc" }, error: null }) }) }),
      update: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };
  return { admin: admin as never, updates, asked: () => asked };
}

const sent = (over: Partial<Row> = {}): Row => ({
  id: "a1", type: "leave_license", template_key: "leave_license", status: "sent_to_client",
  variables: { client_address: "To be provided", special_clause_text: "Old clause" }, ...over,
});

describe("regenerateCaseAgreementPdfs with a sent, unsigned agreement", () => {
  it("leaves it alone unless the caller asks for sent ones", async () => {
    const { admin, updates, asked } = fakeAdmin([sent()]);
    await regenerateCaseAgreementPdfs(admin, "c1");
    expect(asked()).toEqual(["draft", "internally_approved"]);
    expect(updates).toHaveLength(0);
  });

  it("rebuilds it as a draft with the case address and the clause it went out with", async () => {
    const { admin, updates } = fakeAdmin([sent()]);
    await regenerateCaseAgreementPdfs(admin, "c1", { includeSent: true });
    const agr = updates.find((u) => u.table === "case_agreements")!.values;
    expect(agr).toMatchObject({ status: "draft", generated_document_id: "newdoc" });
    expect(agr.variables).toMatchObject({ client_address: NEW_ADDRESS, special_clause_text: "Old clause" });
    expect(updates.find((u) => u.table === "cases")!.values).toEqual({ ll_agreement_status: "draft" });
  });

  it("does nothing when the sent agreement already carries the case address", async () => {
    const { admin, updates } = fakeAdmin([sent({ status: "client_approved", variables: { client_address: NEW_ADDRESS, special_clause_text: "Old clause" } })]);
    await regenerateCaseAgreementPdfs(admin, "c1", { includeSent: true });
    expect(updates).toHaveLength(0);
  });

  it("never touches a signed agreement", async () => {
    const { admin, updates } = fakeAdmin([sent({ status: "executed" }), sent({ id: "a2", status: "signing" })]);
    await regenerateCaseAgreementPdfs(admin, "c1", { includeSent: true });
    expect(updates).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Tables hold canned results; every builder method returns the same chain, and
// single()/await resolve to the table's result.
const tables: Record<string, { data: unknown; error: null }> = {};
const updates: { table: string; values: Record<string, unknown> }[] = [];

function builder(table: string) {
  const result = () => tables[table] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "like", "contains", "limit", "order", "insert", "delete"]) chain[m] = () => chain;
  chain.update = (values: Record<string, unknown>) => { updates.push({ table, values }); return chain; };
  chain.single = () => Promise.resolve(result());
  chain.maybeSingle = () => Promise.resolve(result());
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return chain;
}
const client = { auth: { getUser: async () => ({ data: { user: { id: "auth1" } } }) }, from: (t: string) => builder(t) };

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, createAdminClient: async () => client }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), diffChanges: () => ({}) }));
const regenerate = vi.fn();
vi.mock("@/lib/special-clause/case-regenerate", () => ({ regenerateCaseAgreementPdfs: (...a: unknown[]) => regenerate(...a), writeAgreementPdf: vi.fn(async () => "newdoc") }));
vi.mock("@/lib/leegality", () => ({ cancelSigningRequest: vi.fn(async () => undefined) }));

import { PATCH } from "../route";

const baseCase = { id: "c1", client_address: "Old Street, Chennai 600001", client_city: null, client_state: null, client_pincode: null, tenure_months: 12 };
const body = (extra: Record<string, unknown> = {}) => ({ client_address: "New Street, Chennai 600007", ...extra });
const call = (b: Record<string, unknown>) =>
  PATCH(new NextRequest("http://x/api/cases/c1", { method: "PATCH", body: JSON.stringify(b) }), { params: Promise.resolve({ id: "c1" }) });

beforeEach(() => {
  updates.length = 0; regenerate.mockReset();
  for (const k of Object.keys(tables)) delete tables[k];
  tables.cases = { data: baseCase, error: null };
  tables.users = { data: { id: "u1", role: "admin" }, error: null };
});

describe("PATCH /api/cases/[id] address change", () => {
  it("asks for confirmation when an executed agreement exists", async () => {
    tables.case_agreements = { data: [{ id: "a1", type: "leave_license", template_key: "k", status: "executed", variables: {}, generated_document_id: "g", signed_document_id: "s", leegality_document_id: null }], error: null };
    const res = await call(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("AGREEMENT_RESET_REQUIRED");
    expect(updates.find((u) => u.table === "cases")).toBeUndefined(); // nothing saved
  });

  it("refuses a non-admin/manager", async () => {
    tables.users = { data: { id: "u1", role: "sales_rep" }, error: null };
    tables.case_agreements = { data: [{ id: "a1", type: "leave_license", template_key: "k", status: "executed", variables: {}, generated_document_id: "g", signed_document_id: null, leegality_document_id: null }], error: null };
    expect((await call(body())).status).toBe(403);
  });

  it("needs a reason of at least 10 characters", async () => {
    tables.case_agreements = { data: [{ id: "a1", type: "leave_license", template_key: "k", status: "executed", variables: {}, generated_document_id: "g", signed_document_id: null, leegality_document_id: null }], error: null };
    expect((await call(body({ confirm_agreement_reset: true, agreement_reset_reason: "short" }))).status).toBe(400);
  });

  it("saves and resets once confirmed with a reason", async () => {
    tables.case_agreements = { data: [{ id: "a1", type: "leave_license", template_key: "k", status: "executed", variables: {}, generated_document_id: "g", signed_document_id: "s", leegality_document_id: null }], error: null };
    tables.cases = { data: baseCase, error: null };
    const res = await call(body({ confirm_agreement_reset: true, agreement_reset_reason: "address was missing" }));
    expect(res.status).toBe(200);
    expect(updates.find((u) => u.table === "case_agreements")?.values).toMatchObject({ status: "draft", signed_document_id: null });
  });

  it("does not prompt when the address text is unchanged", async () => {
    tables.case_agreements = { data: [{ id: "a1", type: "leave_license", template_key: "k", status: "executed", variables: {}, generated_document_id: "g", signed_document_id: null, leegality_document_id: null }], error: null };
    const res = await call({ client_address: "  old street,  chennai 600001 " });
    expect(res.status).toBe(200);
  });

  it("does not prompt when no agreement is signed (draft refresh only)", async () => {
    tables.case_agreements = { data: [], error: null };
    const res = await call(body());
    expect(res.status).toBe(200);
    expect(regenerate).toHaveBeenCalled();
  });
});

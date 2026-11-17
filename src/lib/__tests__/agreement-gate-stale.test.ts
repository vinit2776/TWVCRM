import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/special-clause/case-gate", () => ({ caseClauseGateError: () => Promise.resolve(null) }));

import { caseAgreementGateError } from "../agreement-gate";
import { ADDRESS_STALE_REASON } from "../agreement-address-gate";

const CASE = { client_address: "9 New Road", client_city: "Chennai", client_state: "Tamil Nadu", client_pincode: "600002" };

function fakeSupabase(agreementAddress: string) {
  const rows: Record<string, unknown> = {
    case_agreements: { variables: { client_address: agreementAddress } },
    cases: CASE,
  };
  const chain = (table: string) => {
    const q = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: rows[table] }) };
    return q;
  };
  return { from: chain } as never;
}

describe("caseAgreementGateError when the case address has moved on", () => {
  it("blocks an agreement that still carries the old address", async () => {
    expect(await caseAgreementGateError(fakeSupabase("1 Old Lane, Chennai, Tamil Nadu, 600001"), "c1", "a1")).toBe(ADDRESS_STALE_REASON);
  });

  it("lets an agreement through when it carries the case address", async () => {
    expect(await caseAgreementGateError(fakeSupabase("9 new road,  Chennai, Tamil Nadu, 600002"), "c1", "a1")).toBeNull();
  });
});

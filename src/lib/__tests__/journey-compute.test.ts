import { describe, it, expect } from "vitest";
import { computeJourney } from "../journey/compute";
import type { JourneyInput } from "../journey/types";

type ContractInput = NonNullable<JourneyInput["contract"]>;

const baseProposal = {
  id: "p1",
  number: "PROP-0001",
  status: "accepted",
  depositMonths: 2,
  depositStatus: "paid",
  paymentStatus: "paid",
  waiverVerified: false,
  prorataInvoiceSent: true,
};

function contract(over: Partial<ContractInput> = {}): ContractInput {
  return {
    id: "c1",
    number: "TWV-C-0001",
    status: "draft",
    isRenewal: false,
    seats: 4,
    signedDocumentId: null,
    stamped: false,
    activated: false,
    kycTotal: 3,
    kycOutstanding: 3,
    spacesAllocated: 0,
    members: 0,
    vouchersActive: 0,
    hasContractLevelVoucher: false,
    accessDevices: 1,
    membersWithAccess: 0,
    rentStatementExists: false,
    ...over,
  };
}

function input(over: Partial<JourneyInput> = {}): JourneyInput {
  return {
    leadId: "l1",
    leadStatus: "new",
    enquiry: null,
    proposal: null,
    contract: null,
    ...over,
  };
}

const step = (j: ReturnType<typeof computeJourney>, key: string) =>
  j.phases.flatMap((p) => p.steps).find((s) => s.key === key)!;

describe("computeJourney", () => {
  it("starts a brand-new enquiry at first contact", () => {
    const j = computeJourney(
      input({ enquiry: { claimed: true, resolved: false } }),
    );
    expect(step(j, "enquiry_claimed").state).toBe("done");
    expect(j.nextStep?.key).toBe("first_contact");
    expect(j.complete).toBe(false);
  });

  it("does not treat the optional tour as required", () => {
    const j = computeJourney(input({ leadStatus: "contacted" }));
    expect(step(j, "tour").state).toBe("optional");
    expect(j.nextStep?.key).toBe("proposal_drafted");
  });

  it("points a draft proposal at sending, and explains the zero-deposit waiver", () => {
    const j = computeJourney(
      input({
        leadStatus: "proposal_sent",
        proposal: { ...baseProposal, status: "draft", depositMonths: 0, depositStatus: "not_required", paymentStatus: "pending", prorataInvoiceSent: false },
      }),
    );
    const send = step(j, "proposal_sent");
    expect(send.state).toBe("blocked");
    expect(send.hint).toMatch(/waiver/i);
  });

  it("flags a rejected proposal instead of waiting forever", () => {
    const j = computeJourney(
      input({ leadStatus: "negotiating", proposal: { ...baseProposal, status: "rejected", depositStatus: "pending", paymentStatus: "pending" } }),
    );
    expect(step(j, "proposal_sent").hint).toMatch(/rejected/i);
  });

  it("blocks the pro-rata invoice until the deposit is paid", () => {
    const j = computeJourney(
      input({
        leadStatus: "proposal_sent",
        proposal: { ...baseProposal, status: "accepted", depositStatus: "pending", paymentStatus: "pending", prorataInvoiceSent: false },
      }),
    );
    expect(step(j, "deposit_paid").state).toBe("current");
    expect(step(j, "prorata_sent").state).toBe("blocked");
  });

  it("omits the deposit step when no deposit is required", () => {
    const j = computeJourney(
      input({ proposal: { ...baseProposal, depositMonths: 0, depositStatus: "not_required", waiverVerified: true } }),
    );
    expect(j.phases.flatMap((p) => p.steps).some((s) => s.key === "deposit_paid")).toBe(false);
  });

  it("blocks contract creation until the proposal is accepted and the deposit paid", () => {
    const j = computeJourney(
      input({ proposal: { ...baseProposal, status: "sent", depositStatus: "pending", paymentStatus: "pending", prorataInvoiceSent: false } }),
    );
    expect(step(j, "contract_created").state).toBe("blocked");
  });

  it("requires the customer-signed copy before the stamp step", () => {
    const j = computeJourney(input({ proposal: baseProposal, contract: contract() }));
    expect(step(j, "stamped").state).toBe("blocked");
    const signed = computeJourney(input({ proposal: baseProposal, contract: contract({ signedDocumentId: "d1" }) }));
    expect(step(signed, "stamped").state).not.toBe("blocked");
  });

  it("counts KYC as received only when nothing required is outstanding", () => {
    const open = computeJourney(input({ proposal: baseProposal, contract: contract({ kycTotal: 3, kycOutstanding: 1 }) }));
    expect(step(open, "kyc").state).not.toBe("done");
    expect(step(open, "kyc").detail).toBe("2 of 3");
    const done = computeJourney(input({ proposal: baseProposal, contract: contract({ kycTotal: 3, kycOutstanding: 0 }) }));
    expect(step(done, "kyc").state).toBe("done");
  });

  it("warns, without blocking activation, when the agreement is unsigned", () => {
    const j = computeJourney(
      input({ proposal: baseProposal, contract: contract({ status: "accepted", signedDocumentId: null }) }),
    );
    expect(j.warnings.join(" ")).toMatch(/not signed/i);
    expect(step(j, "activated").state).not.toBe("blocked");
  });

  it("blocks WiFi vouchers on an unsigned active contract", () => {
    const j = computeJourney(
      input({
        proposal: baseProposal,
        contract: contract({ status: "active", activated: true, members: 2, signedDocumentId: null }),
      }),
    );
    expect(step(j, "wifi_vouchers").state).toBe("blocked");
    expect(step(j, "wifi_vouchers").hint).toMatch(/signed agreement/i);
  });

  it("counts a contract-level UniFi voucher as WiFi done", () => {
    const j = computeJourney(
      input({
        proposal: baseProposal,
        contract: contract({ status: "active", activated: true, members: 3, signedDocumentId: "d1", hasContractLevelVoucher: true }),
      }),
    );
    expect(step(j, "wifi_vouchers").state).toBe("done");
  });

  it("needs a voucher per member when issuing per seat", () => {
    const partial = computeJourney(
      input({ proposal: baseProposal, contract: contract({ status: "active", activated: true, members: 3, vouchersActive: 2, signedDocumentId: "d1" }) }),
    );
    expect(step(partial, "wifi_vouchers").state).not.toBe("done");
    const full = computeJourney(
      input({ proposal: baseProposal, contract: contract({ status: "active", activated: true, members: 3, vouchersActive: 3, signedDocumentId: "d1" }) }),
    );
    expect(step(full, "wifi_vouchers").state).toBe("done");
  });

  it("leaves door access out when the location has no entry-point controller", () => {
    const j = computeJourney(
      input({ proposal: baseProposal, contract: contract({ status: "active", activated: true, members: 2, accessDevices: 0 }) }),
    );
    expect(j.phases.flatMap((p) => p.steps).some((s) => s.key === "door_access")).toBe(false);
  });

  it("starts a renewal at the contract phase", () => {
    const j = computeJourney(input({ contract: contract({ isRenewal: true }) }));
    expect(j.phases.map((p) => p.key)).not.toContain("money");
    expect(j.phases.map((p) => p.key)).not.toContain("proposal");
    expect(j.nextStep?.phase).toBe("contract");
  });

  it("goes green only when every required step is done", () => {
    const j = computeJourney(
      input({
        leadStatus: "won",
        enquiry: { claimed: true, resolved: true },
        proposal: baseProposal,
        contract: contract({
          status: "active",
          activated: true,
          signedDocumentId: "d1",
          stamped: true,
          kycTotal: 3,
          kycOutstanding: 0,
          spacesAllocated: 4,
          members: 4,
          vouchersActive: 4,
          membersWithAccess: 4,
          rentStatementExists: true,
        }),
      }),
    );
    expect(j.complete).toBe(true);
    expect(j.nextStep).toBeNull();
    expect(j.warnings).toHaveLength(0);
    expect(j.requiredDone).toBe(j.requiredTotal);
  });
});

describe("actionable steps", () => {
  it("lets IT work on vouchers and door access while ops steps are still open", () => {
    const j = computeJourney(
      input({
        proposal: baseProposal,
        contract: contract({ status: "active", activated: true, members: 2, signedDocumentId: "d1", accessDevices: 1 }),
      }),
    );
    expect(step(j, "wifi_vouchers").actionable).toBe(true);
    expect(step(j, "door_access").actionable).toBe(true);
  });

  it("does not mark blocked steps actionable", () => {
    const j = computeJourney(
      input({ proposal: baseProposal, contract: contract({ status: "active", activated: true, members: 2, signedDocumentId: null }) }),
    );
    expect(step(j, "wifi_vouchers").state).toBe("blocked");
    expect(step(j, "wifi_vouchers").actionable).toBe(false);
  });

  it("only treats the current step as actionable before activation", () => {
    const j = computeJourney(input({ proposal: baseProposal, contract: contract() }));
    const actionable = j.phases.flatMap((p) => p.steps).filter((s) => s.actionable);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].key).toBe(j.nextStep?.key);
  });
});

import { describe, it, expect, vi } from "vitest";

// The grouping rules are pure; keep the dispatch/billing modules (and their
// env-dependent clients) out of the test.
vi.mock("@/lib/send-proforma", () => ({ dispatchProforma: vi.fn(), dispatchGstDirect: vi.fn() }));
vi.mock("@/lib/tally-handoff-server", () => ({ handleStatementFinalized: vi.fn() }));
vi.mock("@/lib/billing", () => ({
  monthLabel: (m: number, y: number) => `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`,
  buildServiceDescription: () => "Print - B/W",
  ensureAccountingPeriod: vi.fn(),
}));

import {
  groupUnbilledUsage, buildUsageLineItems, chargeStatus,
  type UnbilledUsageCharge, type ContractFacts,
} from "@/lib/usage-billing";

const TODAY = "2026-09-17";

function charge(over: Partial<UnbilledUsageCharge> & { id: string }): UnbilledUsageCharge {
  const date = over.date ?? "2026-08-20";
  const [year, month] = date.split("-").map(Number);
  return {
    key: `${over.source ?? "manual"}:${over.id}`, source: "manual", contractId: "c1",
    description: `Charge ${over.id}`, quantity: 1, unitPrice: 100, amount: 100,
    date, year, month, held: false, holdReason: null, reviewed: false, bookingNumber: null,
    ...over,
  };
}

function contract(over: Partial<ContractFacts> & { id: string }): ContractFacts {
  return {
    contract_number: `TWV-C-${over.id}`, status: "active", end_date: "2027-06-30",
    billing_mode: "proforma_first", tax_percentage: 18, lead: { company: `Co ${over.id}` },
    ...over,
  };
}

function group(charges: UnbilledUsageCharge[], opts: {
  contracts?: ContractFacts[]; invoiced?: Record<string, string>; locked?: string[];
} = {}) {
  const contracts = new Map((opts.contracts ?? [contract({ id: "c1" })]).map((c) => [c.id, c]));
  return groupUnbilledUsage({
    charges, contracts,
    invoicedMonths: new Map(Object.entries(opts.invoiced ?? {})),
    lockedPeriods: new Set(opts.locked ?? []),
    today: TODAY,
    reviewAfterDays: 60,
  });
}

describe("groupUnbilledUsage", () => {
  it("splits one contract's charges into one group per month, newest first", () => {
    const [g] = group([
      charge({ id: "a", date: "2026-08-05" }),
      charge({ id: "b", date: "2026-09-02" }),
      charge({ id: "c", date: "2026-08-25", source: "print" }),
    ]);
    expect(g.months.map((m) => m.key)).toEqual(["2026-09", "2026-08"]);
    expect(g.months[1].billableKeys.sort()).toEqual(["manual:a", "print:c"]);
  });

  it("locks the current month and allows a closed month", () => {
    const [g] = group([charge({ id: "a", date: "2026-09-02" }), charge({ id: "b", date: "2026-08-02" })]);
    const sep = g.months.find((m) => m.key === "2026-09")!;
    const aug = g.months.find((m) => m.key === "2026-08")!;
    expect(sep).toMatchObject({ block: "open_month", canSend: false });
    expect(aug).toMatchObject({ block: null, canSend: true });
  });

  it("blocks a month locked in accounting", () => {
    const [g] = group([charge({ id: "a", date: "2026-07-10", reviewed: true })], { locked: ["2026-07"] });
    expect(g.months[0]).toMatchObject({ block: "accounting_locked", canSend: false });
  });

  it("keeps held, needs-review and within-quota charges listed but out of the total", () => {
    const [g] = group([
      charge({ id: "ok", date: "2026-08-10", amount: 300 }),
      charge({ id: "held", date: "2026-08-11", amount: 500, held: true }),
      charge({ id: "quota", date: "2026-08-12", amount: 0, source: "facility" }),
    ]);
    const aug = g.months[0];
    expect(aug.charges).toHaveLength(3);
    expect(aug.billableKeys).toEqual(["manual:ok"]);
    expect(aug.subtotal).toBe(300);
    expect(aug.charges.find((c) => c.id === "held")!.status).toBe("held");
    expect(aug.charges.find((c) => c.id === "quota")!.status).toBe("within_quota");
  });

  it("a month with only needs-review charges can't send until reviewed", () => {
    const [g] = group([charge({ id: "old", date: "2026-06-10" })]);
    expect(g.months[0]).toMatchObject({ subtotal: 0, canSend: false });
    expect(g.months[0].charges[0].status).toBe("needs_review");
    const [g2] = group([charge({ id: "old", date: "2026-06-10", reviewed: true })]);
    expect(g2.months[0].canSend).toBe(true);
  });

  it("flags a month that already has a sent invoice, but still allows another", () => {
    const [g] = group([charge({ id: "late" })], { invoiced: { "c1:2026-08": "TWV-BS-0042" } });
    expect(g.months[0]).toMatchObject({ alreadyInvoiced: "TWV-BS-0042", canSend: true });
  });

  it("includes ended contracts and marks them", () => {
    const [g] = group([charge({ id: "a", contractId: "c9" })], {
      contracts: [contract({ id: "c9", status: "terminated", end_date: "2026-08-31" })],
    });
    expect(g.ended).toBe(true);
    expect(g.months[0].canSend).toBe(true);
  });

  it("an active contract past its end date counts as ended; renewal in progress does not", () => {
    const lapsed = group([charge({ id: "a", contractId: "c2" })], { contracts: [contract({ id: "c2", end_date: "2026-08-31" })] });
    expect(lapsed[0].ended).toBe(true);
    const renewing = group([charge({ id: "a", contractId: "c3" })], { contracts: [contract({ id: "c3", status: "renewal_in_progress", end_date: "2026-06-30" })] });
    expect(renewing[0].ended).toBe(false);
  });

  it("takes route and GST rate from the contract", () => {
    const [g] = group([charge({ id: "a", amount: 1000 })], {
      contracts: [contract({ id: "c1", billing_mode: "gst_direct", tax_percentage: 18 })],
    });
    expect(g.billingMode).toBe("gst_direct");
    expect(g.months[0]).toMatchObject({ subtotal: 1000, taxAmount: 180, total: 1180 });
  });

  it("groups several contracts separately and skips charges with no known contract", () => {
    const groups = group(
      [charge({ id: "a", contractId: "c1" }), charge({ id: "b", contractId: "c2" }), charge({ id: "x", contractId: "gone" })],
      { contracts: [contract({ id: "c1" }), contract({ id: "c2" })] },
    );
    expect(groups.map((g) => g.contractId)).toEqual(["c1", "c2"]);
  });
});

describe("chargeStatus", () => {
  it("review cutoff is exclusive at exactly 60 days", () => {
    expect(chargeStatus(charge({ id: "a", date: "2026-07-19" }), TODAY, 60)).toBe("billable");
    expect(chargeStatus(charge({ id: "b", date: "2026-07-18" }), TODAY, 60)).toBe("needs_review");
  });
});

describe("buildUsageLineItems", () => {
  it("builds sections in the shape the PDF and email already render, qty × rate = amount", () => {
    const { sections, manualSubtotal, printSubtotal, facilitySubtotal } = buildUsageLineItems([
      charge({ id: "m", quantity: 3, unitPrice: 200, amount: 600 }),
      charge({ id: "p", source: "print", quantity: 50, unitPrice: 5, amount: 250 }),
      charge({ id: "f", source: "facility", quantity: 2, unitPrice: 400, amount: 800 }),
    ], 2026, 8);
    expect(sections.map((s) => s.type)).toEqual(["ad_hoc_charges", "facility_usage", "service_usage"]);
    expect(sections[0].items[0]).toMatchObject({ usage_charge_id: "m", quantity: 3, unit_price: 200, amount: 600 });
    expect(sections[2].items[0]).toMatchObject({ qty: 50, unit_price: 5, amount: 250 });
    expect(sections[1].label).toBe("Facility Usage — Aug 2026");
    expect([manualSubtotal, printSubtotal, facilitySubtotal]).toEqual([600, 250, 800]);
    for (const sec of sections) for (const it of sec.items as unknown as Array<Record<string, number>>) {
      expect((it.quantity ?? it.qty) * it.unit_price).toBe(it.amount);
    }
  });

  it("omits empty sections", () => {
    const { sections } = buildUsageLineItems([charge({ id: "m" })], 2026, 8);
    expect(sections.map((s) => s.type)).toEqual(["ad_hoc_charges"]);
  });
});

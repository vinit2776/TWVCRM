import { describe, it, expect } from "vitest";
import {
  buildCustomerOptions,
  checkTicketContract,
  customerDisplayName,
  customerForUnit,
  searchCustomerOptions,
  type HeldUnit,
  type RawTicketContract,
} from "@/lib/facility/ticket-customer";

const TODAY = "2026-10-19";

const contract = (id: string, over: Partial<RawTicketContract> = {}): RawTicketContract => ({
  id, lead_id: `lead-${id}`, contract_number: `TWV-C-${id}`,
  lead: { first_name: "Priya", last_name: "Shah", company: "Acme Analytics" }, ...over,
});
const unit = (contractId: string, unitId: string, label: string, over: Partial<HeldUnit> = {}): HeldUnit => ({
  contract_id: contractId, space_unit_id: unitId, label, start_date: "2026-01-01", end_date: null, ...over,
});

describe("customerDisplayName", () => {
  it("prefers the company, then the person, then a placeholder", () => {
    expect(customerDisplayName({ first_name: "A", last_name: "B", company: " Acme " })).toBe("Acme");
    expect(customerDisplayName({ first_name: "Priya", last_name: "Shah", company: null })).toBe("Priya Shah");
    expect(customerDisplayName({ first_name: "Priya", last_name: null, company: "  " })).toBe("Priya");
    expect(customerDisplayName(null)).toBe("Unnamed customer");
  });
});

describe("buildCustomerOptions", () => {
  it("lists the units each contract holds today, once each", () => {
    const [o] = buildCustomerOptions([contract("1")], [unit("1", "u1", "Cabin 4"), unit("1", "u1", "Cabin 4"), unit("1", "u2", "Desk 9")], TODAY);
    expect(o.units).toEqual(["Cabin 4", "Desk 9"]);
    expect(o.unitIds).toEqual(["u1", "u2"]);
  });
  it("ignores units not yet started or already ended", () => {
    const [o] = buildCustomerOptions(
      [contract("1")],
      [unit("1", "past", "Old", { end_date: "2026-06-30" }), unit("1", "future", "Soon", { start_date: "2026-12-01" }), unit("1", "now", "Now", { end_date: "2026-10-19" })],
      TODAY
    );
    expect(o.units).toEqual(["Now"]);
  });
  it("keeps a contract with no units (the customer can still be picked by name)", () => {
    expect(buildCustomerOptions([contract("1")], [], TODAY)[0].units).toEqual([]);
  });
  it("sorts by customer name, then contract number", () => {
    const names = buildCustomerOptions(
      [contract("2", { lead: { first_name: null, last_name: null, company: "Zeta" } }), contract("3"), contract("1")],
      [], TODAY
    ).map((o) => `${o.customerName}/${o.contractNumber}`);
    expect(names).toEqual(["Acme Analytics/TWV-C-1", "Acme Analytics/TWV-C-3", "Zeta/TWV-C-2"]);
  });
});

describe("searchCustomerOptions", () => {
  const options = buildCustomerOptions(
    [contract("1"), contract("2", { lead: { first_name: null, last_name: null, company: "Bolt Legal" } })],
    [unit("1", "u1", "Cabin 4"), unit("2", "u2", "Desk 9")], TODAY
  );
  it("matches customer, contract number and unit, ignoring case", () => {
    expect(searchCustomerOptions(options, "bolt").map((o) => o.contractNumber)).toEqual(["TWV-C-2"]);
    expect(searchCustomerOptions(options, "c-1").map((o) => o.contractNumber)).toEqual(["TWV-C-1"]);
    expect(searchCustomerOptions(options, "CABIN").map((o) => o.contractNumber)).toEqual(["TWV-C-1"]);
  });
  it("returns everything for an empty search and nothing for no match", () => {
    expect(searchCustomerOptions(options, "  ")).toHaveLength(2);
    expect(searchCustomerOptions(options, "zzz")).toEqual([]);
  });
});

describe("customerForUnit", () => {
  const options = buildCustomerOptions(
    [contract("1"), contract("2"), contract("3")],
    [unit("1", "solo", "A"), unit("2", "shared", "B"), unit("3", "shared", "B")], TODAY
  );
  it("returns the single holder of a unit", () => {
    expect(customerForUnit(options, "solo")?.contractId).toBe("1");
  });
  it("never guesses between customers who share a unit, or for a unit nobody holds", () => {
    expect(customerForUnit(options, "shared")).toBeNull();
    expect(customerForUnit(options, "nobody")).toBeNull();
  });
  it("returns nothing when no unit is chosen", () => {
    expect(customerForUnit(options, "")).toBeNull();
    expect(customerForUnit(options, null)).toBeNull();
  });
});

describe("checkTicketContract", () => {
  it("accepts a live contract at the ticket's location", () => {
    expect(checkTicketContract({ id: "c", status: "active", location_id: "L1" }, "L1")).toEqual({ ok: true });
    expect(checkTicketContract({ id: "c", status: "renewal_in_progress", location_id: "L1" }, "L1")).toEqual({ ok: true });
  });
  it("rejects a missing contract, an ended one, and one from another location", () => {
    expect(checkTicketContract(null, "L1").ok).toBe(false);
    for (const status of ["draft", "expired", "terminated", "renewed"]) {
      expect(checkTicketContract({ id: "c", status, location_id: "L1" }, "L1").ok).toBe(false);
    }
    const other = checkTicketContract({ id: "c", status: "active", location_id: "L2" }, "L1");
    expect(other).toEqual({ ok: false, error: "That customer is not at this location" });
    expect(checkTicketContract({ id: "c", status: "active", location_id: null }, "L1").ok).toBe(false);
  });
});

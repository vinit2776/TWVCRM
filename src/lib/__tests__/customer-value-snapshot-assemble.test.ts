import { describe, it, expect } from "vitest";
import {
  assembleCustomers,
  toMonthlyRecord,
  type FetchedContract,
  type FetchedSnapshotData,
  type FetchedTicket,
} from "@/lib/customer-value/snapshot-assemble";
import { buildMonthlyRows, type MonthlyRow } from "@/lib/customer-value/monthly-metrics";

function contract(id: string, leadId: string, locationId: string | null, over: Partial<FetchedContract> = {}): FetchedContract {
  return {
    id,
    lead_id: leadId,
    location_id: locationId,
    contract_number: `TWV-C-${id}`,
    status: "active",
    start_date: "2026-04-01",
    end_date: "2027-03-31",
    activated_at: "2026-04-01T04:00:00Z",
    terminated_at: null,
    seats: 10,
    subtotal: 50000,
    escalation_percentage: 10,
    escalation_waived: false,
    escalation_approval_status: null,
    parent_contract_id: null,
    renewal_sequence: 1,
    days_extended: 0,
    phase_start_date: null,
    renewal_declined: false,
    renewal_agreed_note: null,
    rate_phases: [],
    ...over,
  };
}

function ticket(id: string, locationId: string, over: Partial<FetchedTicket> = {}): FetchedTicket {
  return {
    id,
    location_id: locationId,
    reported_at: "2026-09-10T06:00:00Z",
    space_unit_id: null,
    reporter_email: null,
    reporter_phone: null,
    sla_breached: false,
    reopen_count: 0,
    satisfaction_rating: null,
    ...over,
  };
}

const EMPTY: FetchedSnapshotData = {
  contracts: [],
  statements: [],
  payments: [],
  reminders: [],
  rentWaivers: [],
  moratoriums: [],
  bookings: [],
  bookingWaivers: [],
  refunds: [],
  creditNotes: [],
  tickets: [],
  directoryContracts: [],
  allocations: [],
  members: [],
  billingQueries: [],
};

/** Two customers share a center; a third is elsewhere. */
function world(): FetchedSnapshotData {
  const contracts = [contract("a1", "acme", "loc1"), contract("b1", "bolt", "loc1"), contract("s1", "solo", "loc2")];
  return {
    ...EMPTY,
    contracts,
    directoryContracts: contracts.map((c) => ({ id: c.id, lead_id: c.lead_id, location_id: c.location_id })),
    allocations: [{ contract_id: "a1", space_unit_id: "unit-1", start_date: "2026-04-01", end_date: null }],
    members: [{ contract_id: "b1", email: "dev@bolt.example", phone: null }],
    tickets: [
      ticket("t-space", "loc1", { space_unit_id: "unit-1" }), // acme, by space
      ticket("t-reporter", "loc1", { reporter_email: "dev@bolt.example" }), // bolt, by reporter
      ticket("t-nobody", "loc1", { reported_at: "2026-08-12T06:00:00Z" }), // unlinked, August
      ticket("t-nobody2", "loc1"), // unlinked, September
    ],
  };
}

describe("assembleCustomers: tickets", () => {
  const out = assembleCustomers(world(), ["acme", "bolt", "solo"]);

  it("gives each customer only their own tickets", () => {
    expect(out.get("acme")?.raw.tickets.map((t) => t.id)).toEqual(["t-space"]);
    expect(out.get("bolt")?.raw.tickets.map((t) => t.id)).toEqual(["t-reporter"]);
    expect(out.get("solo")?.raw.tickets).toEqual([]);
  });

  it("counts the center's unattributed tickets by month for everyone there", () => {
    expect(out.get("acme")?.raw.ticketsUnlinkedByMonth).toEqual({ "2026-08-01": 1, "2026-09-01": 1 });
    expect(out.get("bolt")?.raw.ticketsUnlinkedByMonth).toEqual({ "2026-08-01": 1, "2026-09-01": 1 });
    expect(out.get("solo")?.raw.ticketsUnlinkedByMonth).toEqual({});
  });

  it("reports the share of the center's tickets that could be tied to a customer", () => {
    expect(out.get("acme")?.ticketLinkCoverage).toBe(0.5); // 2 of 4
    expect(out.get("solo")?.ticketLinkCoverage).toBeNull(); // no tickets at their center
  });

  it("links using customers who are not in the batch, so a neighbour is not mistaken for nobody", () => {
    // Only acme is requested, but bolt holds the shared directory entry for its reporter.
    const onlyAcme = assembleCustomers(world(), ["acme"]);
    expect(onlyAcme.get("acme")?.raw.tickets.map((t) => t.id)).toEqual(["t-space"]);
    expect(onlyAcme.get("acme")?.ticketLinkCoverage).toBe(0.5);
  });

  it("pools a multi-location customer's tickets and coverage across their centers", () => {
    const data = world();
    const extra = contract("a2", "acme", "loc2");
    data.contracts.push(extra);
    data.directoryContracts.push({ id: "a2", lead_id: "acme", location_id: "loc2" });
    data.tickets.push(ticket("t-loc2-unlinked", "loc2"));
    const multi = assembleCustomers(data, ["acme"]).get("acme");
    expect(multi?.locationIds.sort()).toEqual(["loc1", "loc2"]);
    expect(multi?.ticketLinkCoverage).toBeCloseTo(2 / 5, 10); // 2 linked of 4 + 1
    expect(multi?.raw.ticketsUnlinkedByMonth?.["2026-09-01"]).toBe(2);
  });

  it("carries the fields the builder needs through to each ticket", () => {
    const data = world();
    data.tickets[0] = ticket("t-space", "loc1", { space_unit_id: "unit-1", sla_breached: true, reopen_count: 2, satisfaction_rating: 3 });
    const t = assembleCustomers(data, ["acme"]).get("acme")?.raw.tickets[0];
    expect(t).toMatchObject({ sla_breached: true, reopen_count: 2, satisfaction_rating: 3 });
  });
});

describe("assembleCustomers: records follow the right customer", () => {
  const data: FetchedSnapshotData = {
    ...EMPTY,
    contracts: [contract("a1", "acme", "loc1"), contract("b1", "bolt", "loc1")],
    statements: [
      { id: "sa", lead_id: "acme", period_start: "2026-08-01", subtotal: 50000, total_amount: 59000, status: "finalized", due_date: "2026-09-07", finalized_at: null },
      { id: "sb", lead_id: "bolt", period_start: "2026-08-01", subtotal: 20000, total_amount: 23600, status: "finalized", due_date: "2026-09-07", finalized_at: null },
    ],
    payments: [
      { billing_statement_id: "sa", amount: 59000, tds_amount: 0, payment_date: "2026-09-07", created_at: "2026-09-07T06:00:00Z" },
    ],
    reminders: [{ billing_statement_id: "sb", sent_at: "2026-09-10T06:00:00Z", status: "sent" }],
    bookings: [
      { id: "bk-a", lead_id: "acme", booking_date: "2026-09-03", status: "confirmed" },
      { id: "bk-b", lead_id: "bolt", booking_date: "2026-09-04", status: "confirmed" },
    ],
    billingQueries: [{ billing_statement_id: "sb", created_at: "2026-09-12T06:00:00Z" }],
  };
  const out = assembleCustomers(data, ["acme", "bolt"]);

  it("sorts statements, payments, reminders, bookings and queries by customer", () => {
    expect(out.get("acme")?.raw.statements.map((s) => s.id)).toEqual(["sa"]);
    expect(out.get("bolt")?.raw.statements.map((s) => s.id)).toEqual(["sb"]);
    expect(out.get("acme")?.raw.payments).toHaveLength(1);
    expect(out.get("bolt")?.raw.payments).toHaveLength(0);
    expect(out.get("bolt")?.raw.reminders).toHaveLength(1);
    expect(out.get("acme")?.raw.reminders).toHaveLength(0);
    expect(out.get("acme")?.raw.bookings.map((b) => b.booking_date)).toEqual(["2026-09-03"]);
    expect(out.get("bolt")?.raw.billingQueries).toHaveLength(1);
    expect(out.get("acme")?.raw.billingQueries).toEqual([]);
  });

  it("passes billing queries on as unknown, not zero, when they could not be counted", () => {
    const unavailable = assembleCustomers({ ...data, billingQueries: null }, ["acme"]);
    expect(unavailable.get("acme")?.raw.billingQueries).toBeNull();
  });

  it("still returns an entry for a customer with nothing at all", () => {
    const none = assembleCustomers(EMPTY, ["ghost"]).get("ghost");
    expect(none?.raw.contracts).toEqual([]);
    expect(none?.ticketLinkCoverage).toBeNull();
    expect(buildMonthlyRows(none!.raw, "2026-10-17")).toEqual([]);
  });
});

describe("assembleCustomers: concessions", () => {
  const base: FetchedSnapshotData = {
    ...EMPTY,
    contracts: [contract("a1", "acme", "loc1")],
    bookings: [{ id: "bk-a", lead_id: "acme", booking_date: "2026-09-03", status: "confirmed" }],
  };

  it("counts only what the Money tab counts: a giveaway, an approved booking waiver, a processed refund, a credit note", () => {
    const data: FetchedSnapshotData = {
      ...base,
      statements: [{ id: "sa", lead_id: "acme", period_start: "2026-08-01", subtotal: 1, total_amount: 1, status: "finalized", due_date: null, finalized_at: null }],
      rentWaivers: [
        { contract_id: "a1", waived_month: "2026-07-01", reason: "AC", revoked_at: null, waiver_kind: "giveaway" },
        { contract_id: "a1", waived_month: "2026-06-01", reason: "billed before", revoked_at: null, waiver_kind: "billed_elsewhere" },
        { contract_id: "a1", waived_month: "2026-05-01", reason: null, revoked_at: null, waiver_kind: "unknown" },
      ],
      bookingWaivers: [
        { booking_id: "bk-a", waiver_type: "overtime", waiver_amount: 800, status: "approved", approved_at: "2026-09-05T06:00:00Z", created_at: "2026-09-05T05:00:00Z", note: null },
        { booking_id: "bk-a", waiver_type: "other", waiver_amount: 999, status: "pending", approved_at: null, created_at: "2026-09-06T05:00:00Z", note: null },
      ],
      refunds: [{ booking_id: "bk-a", amount_requested: 2000, status: "processed", processed_at: "2026-09-10T06:00:00Z", requested_at: "2026-09-08T06:00:00Z", reason: null }],
      creditNotes: [{ billing_statement_id: "sa", credit_note_amount: 300, credit_note_date: "2026-09-12", credit_note_number: "CN-1", reason: null, superseded_by: null }],
    };
    const concessions = assembleCustomers(data, ["acme"]).get("acme")!.raw.concessions;
    const byDate = Object.fromEntries(concessions.map((c) => [c.date, c.amount]));
    expect(byDate["2026-07-01"]).toBe(50000); // the giveaway, at that month's rent
    expect(byDate["2026-06-01"]).toBeUndefined(); // billed elsewhere
    expect(byDate["2026-05-01"]).toBeUndefined(); // not classified
    expect(concessions.map((c) => c.amount).sort((a, b) => a - b)).toEqual([300, 800, 2000, 50000]);
  });
});

describe("toMonthlyRecord", () => {
  const row: MonthlyRow = {
    month: "2026-09-01",
    revenue_ex_gst: 50000.456,
    invoiced_count: 1,
    avg_days_late: 3.14159,
    measured_count: 1,
    on_time_count: 0,
    overdue_amount: 0,
    max_days_overdue: 0,
    reminders: 2,
    concessions_counted: 0,
    seats_paid: 11.99999,
    seats_used_avg: null,
    rent_per_seat: 4166.6666,
    tickets_linked: 1,
    tickets_unlinked: 3,
    tickets_sla_breached: 0,
    tickets_reopened: 0,
    satisfaction_avg: 4.3333,
    satisfaction_count: 3,
    bookings: 4,
    billing_queries: null,
    data_flags: { invoices_without_due_date: 0, door: "none", billing_queries_available: false, partial_month: false },
  };

  it("rounds to the table's precision and keeps unknowns as null", () => {
    const rec = toMonthlyRecord("lead-1", row, 0.6666, "2026-10-17T00:00:00Z");
    expect(rec).toMatchObject({
      lead_id: "lead-1",
      month: "2026-09-01",
      revenue_ex_gst: 50000.46,
      avg_days_late: 3.14,
      seats_paid: 12,
      seats_used_avg: null,
      rent_per_seat: 4166.67,
      satisfaction_avg: 4.33,
      billing_queries: null,
      computed_at: "2026-10-17T00:00:00Z",
    });
  });

  it("stores the data flags with the center's ticket attribution coverage added", () => {
    const rec = toMonthlyRecord("lead-1", row, 0.6666, "2026-10-17T00:00:00Z");
    expect(rec.data_flags).toEqual({
      invoices_without_due_date: 0,
      door: "none",
      billing_queries_available: false,
      partial_month: false,
      ticket_link_coverage: 0.667,
    });
    expect(toMonthlyRecord("lead-1", row, null, "x").data_flags.ticket_link_coverage).toBeNull();
  });

  it("produces the same record for the same inputs", () => {
    expect(toMonthlyRecord("lead-1", row, 0.5, "t")).toEqual(toMonthlyRecord("lead-1", row, 0.5, "t"));
  });
});

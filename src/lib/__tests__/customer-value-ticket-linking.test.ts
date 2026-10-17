import { describe, it, expect } from "vitest";
import {
  linkTickets,
  normalizeEmail,
  normalizePhone,
  ticketLinkCoverage,
  type LinkableTicket,
  type TicketDirectory,
} from "@/lib/customer-value/ticket-linking";

function ticket(id: string, over: Partial<LinkableTicket> = {}): LinkableTicket {
  return {
    id,
    reported_at: "2026-09-10T06:00:00Z",
    space_unit_id: null,
    reporter_email: null,
    reporter_phone: null,
    ...over,
  };
}

const DIR: TicketDirectory = {
  allocations: [
    { lead_id: "acme", space_unit_id: "unit-1", start_date: "2026-04-01", end_date: null },
    { lead_id: "oldco", space_unit_id: "unit-2", start_date: "2025-01-01", end_date: "2026-06-30" },
    { lead_id: "newco", space_unit_id: "unit-2", start_date: "2026-07-01", end_date: null },
    // A shared unit held by two customers at once.
    { lead_id: "acme", space_unit_id: "unit-3", start_date: "2026-04-01", end_date: null },
    { lead_id: "bolt", space_unit_id: "unit-3", start_date: "2026-04-01", end_date: null },
  ],
  members: [
    { lead_id: "acme", email: "Priya@Acme.example", phone: "+91 98765 43210" },
    { lead_id: "bolt", email: "dev@bolt.example", phone: "9123456780" },
    // The same person enrolled under two customers.
    { lead_id: "acme", email: "shared@temp.example", phone: null },
    { lead_id: "bolt", email: "shared@temp.example", phone: null },
  ],
};

const via = (t: LinkableTicket, dir = DIR) => linkTickets([t], dir).get(t.id);

describe("normalising contact details", () => {
  it("lower-cases emails and rejects non-emails", () => {
    expect(normalizeEmail("  Priya@Acme.EXAMPLE ")).toBe("priya@acme.example");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
  it("keeps the last ten digits of a phone number", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("9876543210");
    expect(normalizePhone("09876543210")).toBe("9876543210");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("linkTickets: by space", () => {
  it("ties a ticket to the one customer who held the unit that day", () => {
    expect(via(ticket("t", { space_unit_id: "unit-1" }))).toEqual({ leadId: "acme", via: "allocation" });
  });

  it("follows the unit from one customer to the next by date", () => {
    expect(via(ticket("before", { space_unit_id: "unit-2", reported_at: "2026-06-30T06:00:00Z" }))).toEqual({
      leadId: "oldco",
      via: "allocation",
    });
    expect(via(ticket("after", { space_unit_id: "unit-2", reported_at: "2026-07-01T06:00:00Z" }))).toEqual({
      leadId: "newco",
      via: "allocation",
    });
  });

  it("does not tie a ticket to a customer whose allocation had already ended", () => {
    const afterAll = ticket("gap", { space_unit_id: "unit-9", reported_at: "2026-09-10T06:00:00Z" });
    expect(via(afterAll)).toEqual({ leadId: null, via: null });
  });

  it("reads the reported date in IST, not UTC", () => {
    // 19:00 UTC on 30 June is already 1 July in India.
    const t = ticket("edge", { space_unit_id: "unit-2", reported_at: "2026-06-30T19:00:00Z" });
    expect(via(t)).toEqual({ leadId: "newco", via: "allocation" });
  });
});

describe("linkTickets: by reporter", () => {
  it("ties a ticket with no unit to a member by email, ignoring case", () => {
    expect(via(ticket("t", { reporter_email: "priya@acme.example" }))).toEqual({ leadId: "acme", via: "reporter" });
  });

  it("ties by phone however it is written", () => {
    expect(via(ticket("t", { reporter_phone: "098765 43210" }))).toEqual({ leadId: "acme", via: "reporter" });
  });

  it("leaves a ticket unlinked when the reporter belongs to two customers", () => {
    expect(via(ticket("t", { reporter_email: "shared@temp.example" }))).toEqual({ leadId: null, via: null });
  });

  it("leaves a ticket unlinked when the reporter is nobody we know", () => {
    expect(via(ticket("t", { reporter_email: "stranger@elsewhere.example" }))).toEqual({ leadId: null, via: null });
  });

  it("leaves a ticket unlinked when it names neither a unit nor a reporter", () => {
    expect(via(ticket("t"))).toEqual({ leadId: null, via: null });
  });
});

describe("linkTickets: shared units", () => {
  it("does not guess between two customers who share a unit", () => {
    expect(via(ticket("t", { space_unit_id: "unit-3" }))).toEqual({ leadId: null, via: null });
  });

  it("lets the reporter settle a shared unit, but only among its holders", () => {
    expect(via(ticket("t", { space_unit_id: "unit-3", reporter_email: "dev@bolt.example" }))).toEqual({
      leadId: "bolt",
      via: "reporter",
    });
    // The reporter belongs to a customer who does not hold this unit: no link.
    const outsider: TicketDirectory = {
      ...DIR,
      members: [...DIR.members, { lead_id: "zeta", email: "z@zeta.example", phone: null }],
    };
    expect(via(ticket("t", { space_unit_id: "unit-3", reporter_email: "z@zeta.example" }), outsider)).toEqual({
      leadId: null,
      via: null,
    });
  });

  it("falls back to the reporter when no one held the unit that day", () => {
    const t = ticket("t", { space_unit_id: "unit-9", reporter_email: "dev@bolt.example" });
    expect(via(t)).toEqual({ leadId: "bolt", via: "reporter" });
  });
});

describe("ticketLinkCoverage", () => {
  it("is the share of tickets that were tied to a customer", () => {
    const links = linkTickets(
      [
        ticket("a", { space_unit_id: "unit-1" }),
        ticket("b", { reporter_email: "dev@bolt.example" }),
        ticket("c"),
        ticket("d"),
      ],
      DIR
    );
    expect(ticketLinkCoverage(links)).toBe(0.5);
  });

  it("is null when there were no tickets, not zero", () => {
    expect(ticketLinkCoverage(new Map())).toBeNull();
  });
});

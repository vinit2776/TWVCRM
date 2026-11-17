import { describe, it, expect } from "vitest";
import { matchLocationIds, contactBackPrefill, contactBackHints } from "../contact-back";

const locs = [
  { id: "k", name: "Koramangala" },
  { id: "i", name: "Indiranagar" },
  { id: "h", name: "HSR Layout" },
];

describe("matchLocationIds", () => {
  it("finds every centre the text names", () => {
    expect(matchLocationIds("Koramangala, Indiranagar", locs)).toEqual(["k", "i"]);
    expect(matchLocationIds("hsr layout", locs)).toEqual(["h"]);
  });
  it("falls back to the lead's own location, then to nothing", () => {
    expect(matchLocationIds("somewhere else", locs, "i")).toEqual(["i"]);
    expect(matchLocationIds("", locs, "gone")).toEqual([]);
    expect(matchLocationIds(undefined, locs)).toEqual([]);
  });
});

describe("contactBackPrefill", () => {
  const src = {
    payload: { name: "Meera Nair", mobile: "9886055512", company: "Nair Labs", workspace_type: "private_office", seat_capacity: "8", budget_per_seat: "11000", preferred_location: "Koramangala", start_date: "2026-12-01" },
    lead: { first_name: "Meera", last_name: "Nair", mobile: "9886055512", email: "meera@nairlabs.in", company: null, location_id: "k" },
  };
  it("fills the form from what the customer submitted", () => {
    const p = contactBackPrefill(src, locs);
    expect(p).toMatchObject({ locationIds: ["k"], types: ["private_office"], seats: 8, startDate: "2026-12-01", budget: "11000", phone: "9886055512", email: "meera@nairlabs.in", name: "Meera Nair", company: "Nair Labs" });
  });
  it("copes with a WhatsApp enquiry that carries no form fields", () => {
    const p = contactBackPrefill({ payload: { messages: [] } as never, lead: { first_name: "WhatsApp contact", mobile: "9000000001" } }, locs);
    expect(p.locationIds).toEqual([]);
    expect(p.types).toEqual([]);
    expect(p.seats).toBe(1);
    expect(p.budget).toBe("");
  });
  it("ignores a start date that is not a calendar date, and an unknown space type", () => {
    const p = contactBackPrefill({ payload: { workspace_type: "castle", start_date: "next month" }, lead: null }, locs);
    expect(p.startDate).toBe("");
    expect(p.types).toEqual([]);
  });
});

describe("contactBackHints", () => {
  it("words what the form said, and leaves out what it did not", () => {
    expect(contactBackHints({ payload: { preferred_location: "Koramangala", workspace_type: "private_office", seat_capacity: 8, start_date: "1 Dec", budget_per_seat: "11000" }, lead: null })).toEqual({
      location: "Koramangala",
      type: "Private Office/Cabin",
      seatsAndStart: "8 seats · start 1 Dec",
      budget: "budget ₹11,000 per seat",
    });
    expect(contactBackHints({ payload: null, lead: null })).toEqual({});
  });
});

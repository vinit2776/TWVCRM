import { describe, it, expect } from "vitest";
import {
  activityEvent,
  enquiryEvent,
  proposalEvents,
  contractEvents,
  paymentEvent,
  sortTimeline,
  nextStep,
} from "../lead-timeline";

const money = (n: number) => `₹${n}`;

describe("activityEvent", () => {
  it("names the person who logged it, as stored, whoever handles the lead now", () => {
    const e = activityEvent({ id: "1", type: "call", subject: "Spoke", description: "Wants 4 desks", created_at: "2026-11-03T10:00:00Z", creator: { full_name: "Priya" } });
    expect(e.actor).toBe("Priya");
    expect(e.title).toBe("Spoke");
    expect(e.group).toBe("calls");
  });

  it("files a hand-over note under system and a quote under documents", () => {
    expect(activityEvent({ id: "2", type: "note", subject: "Reassigned", description: "Priya → Arjun", created_at: "2026-11-03T11:00:00Z", creator: { full_name: "Priya" } }).group).toBe("system");
    expect(activityEvent({ id: "3", type: "email", subject: "Quote sent", created_at: "2026-11-03T12:00:00Z" }).group).toBe("documents");
  });

  it("says where a tour is held", () => {
    expect(activityEvent({ id: "4", type: "tour", subject: "Tour booked", meeting_location: "Koramangala", created_at: "2026-11-03T12:00:00Z" }).detail).toBe("at Koramangala");
  });
});

describe("enquiryEvent", () => {
  it("attributes the enquiry to the customer and quotes what they wrote", () => {
    const e = enquiryEvent({ id: "e", reference: "TWV-E-0412", source: "google_ads", received_at: "2026-11-03T08:35:00Z", payload: { name: "Meera", description: "Need a cabin" } }, "Google Ads");
    expect(e.actorKind).toBe("customer");
    expect(e.actor).toBe("Meera");
    expect(e.detail).toBe("“Need a cabin”");
    expect(e.links[0].label).toBe("TWV-E-0412");
  });
});

describe("proposalEvents", () => {
  it("emits one event per milestone it reached, each linking to the proposal", () => {
    const events = proposalEvents({ id: "p", proposal_number: "PROP-0420", created_at: "2026-11-03T10:00:00Z", sent_at: "2026-11-03T13:00:00Z", viewed_at: "2026-11-03T13:30:00Z" }, "Arjun");
    expect(events.map((e) => e.title)).toEqual(["Proposal drafted", "Proposal sent", "Customer opened the proposal"]);
    expect(events.every((e) => e.links[0].href === "/proposals/p")).toBe(true);
    expect(events[2].actorKind).toBe("customer");
  });
});

describe("contractEvents", () => {
  it("adds Contract activated only once it is active", () => {
    expect(contractEvents({ id: "c", contract_number: "TWV-C-1", created_at: "2026-11-03T10:00:00Z" })).toHaveLength(1);
    expect(contractEvents({ id: "c", contract_number: "TWV-C-1", created_at: "2026-11-03T10:00:00Z", activated_at: "2026-11-04T10:00:00Z" })).toHaveLength(2);
  });
});

describe("paymentEvent", () => {
  it("credits an online payment to the customer and an entered one to the person who recorded it", () => {
    const online = paymentEvent({ id: "1", billing_statement_id: "s", amount: 500, payment_mode: "razorpay", created_at: "2026-11-04T09:40:00Z", razorpay_payment_id: "pay_1" }, "BS-1", money);
    expect(online.actorKind).toBe("customer");
    const manual = paymentEvent({ id: "2", billing_statement_id: "s", amount: 500, payment_mode: "neft", created_at: "2026-11-04T09:40:00Z", recorder: { full_name: "Accounts" } }, "BS-1", money);
    expect(manual.actor).toBe("Accounts");
  });
});

describe("sortTimeline and nextStep", () => {
  it("lists the newest event first", () => {
    const a = activityEvent({ id: "a", type: "call", created_at: "2026-11-03T10:00:00Z" });
    const b = activityEvent({ id: "b", type: "call", created_at: "2026-11-04T10:00:00Z" });
    expect(sortTimeline([a, b]).map((e) => e.id)).toEqual(["activity-b", "activity-a"]);
  });

  it("pins the earliest follow-up that is not done", () => {
    const step = nextStep([
      { id: "1", type: "call", created_at: "x", follow_up_date: "2026-11-09T05:00:00Z", follow_up_notes: "later", is_follow_up_done: false },
      { id: "2", type: "call", created_at: "x", follow_up_date: "2026-11-05T05:00:00Z", follow_up_notes: "soon", is_follow_up_done: false },
      { id: "3", type: "call", created_at: "x", follow_up_date: "2026-11-04T05:00:00Z", follow_up_notes: "done already", is_follow_up_done: true },
    ]);
    expect(step?.notes).toBe("soon");
    expect(nextStep([])).toBeNull();
  });
});

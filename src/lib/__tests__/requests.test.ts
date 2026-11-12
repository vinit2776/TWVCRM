import { describe, it, expect } from "vitest";
import { classifyRequest, isRequestOverdue, requestDueAt, requestTaskTitle, REQUEST_TYPES, REQUEST_OWNER_ROLE, REQUEST_REPLY_TARGET_HOURS } from "../requests";

describe("classifyRequest", () => {
  it("recognises each of the five request types", () => {
    expect(classifyRequest("Please send the October invoice again")).toBe("invoice_copy");
    expect(classifyRequest("Can you share the GST invoice copy")).toBe("invoice_copy");
    expect(classifyRequest("Need a visitor pass for tomorrow")).toBe("access_pass");
    expect(classifyRequest("I lost my access card")).toBe("access_pass");
    expect(classifyRequest("We need 3 more seats from next month")).toBe("add_seats");
    expect(classifyRequest("Planning to expand, need a bigger cabin")).toBe("add_seats");
    expect(classifyRequest("When does our agreement end? We want to renew")).toBe("renewal_contract");
    expect(classifyRequest("Can I move my booking to Friday?")).toBe("booking_change");
    expect(classifyRequest("Please reschedule the meeting room to 4pm")).toBe("booking_change");
  });
  it("returns null for chatter and for messages that merely mention a word", () => {
    expect(classifyRequest("Thanks, will pay tomorrow")).toBeNull();
    expect(classifyRequest("ok noted")).toBeNull();
    expect(classifyRequest("")).toBeNull();
    expect(classifyRequest("Payment done, invoice number 1234")).toBeNull();
    expect(classifyRequest("Do you have private cabins available for 5 seats")).toBeNull();
  });
  it("a booking move is never read as a contract question", () => {
    expect(classifyRequest("Can we extend my booking by an hour")).toBe("booking_change");
  });
});

describe("owners and targets", () => {
  it("every type has an owner role and a reply target", () => {
    for (const t of REQUEST_TYPES) {
      expect(REQUEST_OWNER_ROLE[t]).toBeTruthy();
      expect(REQUEST_REPLY_TARGET_HOURS[t]).toBeGreaterThan(0);
    }
    expect(REQUEST_OWNER_ROLE.invoice_copy).toBe("accounts");
    expect(REQUEST_REPLY_TARGET_HOURS.add_seats).toBe(1);
  });
  it("due time is the target hours later, and overdue only while open", () => {
    const from = new Date("2026-11-02T10:00:00Z");
    expect(requestDueAt("invoice_copy", from).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(isRequestOverdue("2026-11-02T14:00:00Z", true, new Date("2026-11-02T15:00:00Z"))).toBe(true);
    expect(isRequestOverdue("2026-11-02T14:00:00Z", false, new Date("2026-11-02T15:00:00Z"))).toBe(false);
    expect(isRequestOverdue(null, true)).toBe(false);
  });
  it("task title carries type, reference and customer", () => {
    expect(requestTaskTitle("invoice_copy", "REQ-0012", "Meera K.")).toBe("Invoice copy (REQ-0012): Meera K.");
  });
});

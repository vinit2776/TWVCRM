import { describe, it, expect } from "vitest";
import { bookingContactEmail } from "../booking-contact";

describe("bookingContactEmail", () => {
  it("prefers the lead's email, the one the booking page shows", () => {
    expect(bookingContactEmail({ guest_email: "guest@x.com", lead: { email: "lead@x.com" } })).toBe("lead@x.com");
  });

  it("falls back to the guest email, then to nothing", () => {
    expect(bookingContactEmail({ guest_email: "guest@x.com", lead: null })).toBe("guest@x.com");
    expect(bookingContactEmail({ guest_email: null, lead: { email: null } })).toBeNull();
  });
});

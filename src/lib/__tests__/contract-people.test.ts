import { describe, it, expect } from "vitest";
import { computeAccessSetup, isSamePerson, phoneDigits, type PersonAccessRow } from "../contract-people";

function person(over: Partial<PersonAccessRow> & { contactId: string }): PersonAccessRow {
  return {
    memberId: `m-${over.contactId}`,
    name: over.contactId,
    email: `${over.contactId}@example.com`,
    phone: "0000000001",
    isActive: true,
    needsVoucher: true,
    needsDoor: true,
    voucherIssued: false,
    doorEnrolled: false,
    ...over,
  };
}

describe("isSamePerson", () => {
  it("matches on the last 10 phone digits regardless of formatting", () => {
    expect(isSamePerson({ phone: "+91 98765 43210" }, { phone: "9876543210" })).toBe(true);
  });
  it("matches on email ignoring case and spaces", () => {
    expect(isSamePerson({ email: " Riya@Example.com " }, { email: "riya@example.com" })).toBe(true);
  });
  it("does not match when both phone and email are blank", () => {
    expect(isSamePerson({}, {})).toBe(false);
  });
  it("does not match short or different phones", () => {
    expect(phoneDigits("12345")).toBe("12345");
    expect(isSamePerson({ phone: "12345" }, { phone: "12345" })).toBe(false);
  });
});

describe("computeAccessSetup", () => {
  it("is complete when everyone named has what they need, even with open seats", () => {
    const rows = [
      person({ contactId: "a", voucherIssued: true, doorEnrolled: true }),
      person({ contactId: "b", voucherIssued: true, doorEnrolled: true }),
      person({ contactId: "c", voucherIssued: true, doorEnrolled: true }),
    ];
    const s = computeAccessSetup(rows, 5);
    expect(s.state).toBe("complete");
    expect(s.seatsUsed).toBe(3);
    expect(s.seatsOpen).toBe(2);
    expect(s.waitingOn).toBeNull();
  });

  it("is pending and waiting on IT when issuable access is missing", () => {
    const s = computeAccessSetup([person({ contactId: "a" })], 5);
    expect(s.state).toBe("pending");
    expect(s.vouchersPending).toBe(1);
    expect(s.doorPending).toBe(1);
    expect(s.waitingOn).toBe("it");
    expect(s.byContact.a.waitingOn).toBe("it");
  });

  it("waits on sales when only a voucher is pending and there is no email", () => {
    const row = person({ contactId: "a", email: null, needsDoor: false });
    const s = computeAccessSetup([row], 3);
    expect(s.byContact.a.waitingOn).toBe("sales");
    expect(s.byContact.a.salesReason).toBe("email_needed");
    expect(s.waitingOn).toBe("sales");
  });

  it("still waits on IT for door access when the email is missing", () => {
    const row = person({ contactId: "a", email: null });
    expect(computeAccessSetup([row], 3).byContact.a.waitingOn).toBe("it");
  });

  it("prefers IT over sales across people", () => {
    const rows = [
      person({ contactId: "a", email: null, needsDoor: false }),
      person({ contactId: "b" }),
    ];
    expect(computeAccessSetup(rows, 3).waitingOn).toBe("it");
  });

  it("needs review when seats are paid for but nobody is recorded", () => {
    expect(computeAccessSetup([], 8).state).toBe("needs_review");
  });

  it("does not need review when a contract has no seats", () => {
    expect(computeAccessSetup([], 0).state).toBe("complete");
  });

  it("ignores contact-only people, inactive people and things not needed", () => {
    const rows = [
      person({ contactId: "fin", memberId: null }),
      person({ contactId: "left", isActive: false }),
      person({ contactId: "a", needsVoucher: false, needsDoor: true, doorEnrolled: true }),
    ];
    const s = computeAccessSetup(rows, 2);
    expect(s.state).toBe("complete");
    expect(s.seatsUsed).toBe(1);
  });
});

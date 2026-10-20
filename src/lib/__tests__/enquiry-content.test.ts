import { describe, expect, it } from "vitest";
import { enquiryDetails, enquiryMessages } from "@/lib/enquiries";

describe("enquiryMessages", () => {
  it("returns the WhatsApp thread oldest first, dropping blanks", () => {
    const out = enquiryMessages({ messages: [{ at: "a", text: " hi " }, { at: "b", text: "  " }, { at: "c", text: "need 5 seats" }] });
    expect(out.map((m) => m.text)).toEqual(["hi", "need 5 seats"]);
  });
  it("falls back to a form's description", () => {
    expect(enquiryMessages({ description: " tour please " })).toEqual([{ text: "tour please" }]);
  });
  it("is empty with nothing written", () => {
    expect(enquiryMessages(undefined)).toEqual([]);
    expect(enquiryMessages({})).toEqual([]);
  });
});

describe("enquiryDetails", () => {
  it("lists what a form asked for and skips identity fields and blanks", () => {
    const out = enquiryDetails({ name: "A", mobile: "9", seat_capacity: 8, budget_per_seat: "9000", start_date: "", preferred_location: "Andheri" });
    expect(out).toEqual([
      { label: "Seats", value: "8" },
      { label: "Budget per seat", value: "₹9000" },
      { label: "Preferred location", value: "Andheri" },
    ]);
  });
  it("is empty for a chat enquiry", () => {
    expect(enquiryDetails({ messages: [{ text: "hi" }] })).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { enquiryTextMatches } from "../enquiry-text-search";

describe("enquiryTextMatches", () => {
  const form = { description: "Looking for a small team office. Preferred area: ANNA SALAI", preferred_location: "Anna Salai", workspace_type: "private_office" };
  const whatsapp = { messages: [{ text: "Hi sir" }, { text: "Kindly share the images of 4 seater with MD cabin" }] };

  it("finds words in a form description, case-insensitively", () => {
    expect(enquiryTextMatches(form, "small team")).toBe(true);
    expect(enquiryTextMatches(form, "anna salai")).toBe(true);
  });
  it("finds words in any WhatsApp message", () => {
    expect(enquiryTextMatches(whatsapp, "md cabin")).toBe(true);
    expect(enquiryTextMatches(whatsapp, "4 seater")).toBe(true);
  });
  it("does not match what was not said", () => {
    expect(enquiryTextMatches(whatsapp, "parking")).toBe(false);
  });
  it("ignores searches under three characters and empty enquiries", () => {
    expect(enquiryTextMatches(form, "an")).toBe(false);
    expect(enquiryTextMatches(null, "cabin")).toBe(false);
    expect(enquiryTextMatches({}, "cabin")).toBe(false);
  });
  it("copes with null parts", () => {
    expect(enquiryTextMatches({ description: null, messages: [{ text: null }] }, "cabin")).toBe(false);
  });
});

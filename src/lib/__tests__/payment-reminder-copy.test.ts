import { describe, it, expect } from "vitest";
import { STAGES, resolveIntro } from "../payment-reminder";

describe("resolveIntro", () => {
  it("names a tax invoice once a GST invoice has been issued", () => {
    expect(resolveIntro(STAGES[2].intro, "tax invoice"))
      .toContain("The payment for the tax invoice below is now overdue");
  });

  it("still names a proforma when none has been issued", () => {
    expect(resolveIntro(STAGES[2].intro, "proforma"))
      .toContain("The payment for the proforma below is now overdue");
  });

  it("leaves intros that name no document untouched", () => {
    // Stages 3 and 4 talk about "this payment" and carry no {doc} placeholder.
    expect(resolveIntro(STAGES[3].intro, "tax invoice")).toBe(STAGES[3].intro);
  });

  it("never leaks the placeholder for any stage or noun", () => {
    for (const stage of STAGES) {
      for (const noun of ["tax invoice", "proforma"]) {
        expect(resolveIntro(stage.intro, noun)).not.toContain("{doc}");
      }
    }
  });
});

describe("stage subjects", () => {
  it("carry whichever reference the customer actually holds", () => {
    // sendOneReminder passes customerRef = gst_invoice_number || statement_number.
    expect(STAGES[2].subject("SD/A/26-27/284", "7d", "12,980"))
      .toBe("Overdue — SD/A/26-27/284 · ₹12,980");
    expect(STAGES[2].subject("TWV-BS-0294", "7d", "18"))
      .toBe("Overdue — TWV-BS-0294 · ₹18");
  });
});

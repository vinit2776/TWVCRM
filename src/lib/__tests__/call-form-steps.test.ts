import { describe, it, expect } from "vitest";
import { stepsMissing } from "../call-form-steps";

const ready = { real: "real" as const, reached: "spoke" as const, hasLocation: true, hasType: true, contactOk: true, hasWhen: true, hasWhat: true };

describe("stepsMissing", () => {
  it("asks first whether it is real", () => {
    expect(stepsMissing({ ...ready, real: null })).toEqual(["Is this a real enquiry?"]);
  });
  it("needs nothing more to mark an enquiry as not real", () => {
    expect(stepsMissing({ ...ready, real: "junk", reached: null, hasLocation: false, hasWhen: false })).toEqual([]);
  });
  it("asks whether they were reached, and then nothing else until that is answered", () => {
    expect(stepsMissing({ ...ready, reached: null, hasLocation: false, hasWhen: false })).toEqual(["Did you reach them?"]);
  });
  it("after a conversation needs the requirement, a contact and a next step", () => {
    expect(stepsMissing({ ...ready, hasLocation: false, hasType: false, contactOk: false, hasWhen: false, hasWhat: false })).toEqual([
      "Which location",
      "What they want",
      "A phone number or email",
      "When to follow up",
      "What needs to happen",
    ]);
    expect(stepsMissing(ready)).toEqual([]);
  });
  it("after no answer or a WhatsApp reply only the next step is needed", () => {
    for (const reached of ["no_answer", "whatsapp"] as const) {
      expect(stepsMissing({ ...ready, reached, hasLocation: false, hasType: false, contactOk: false, hasWhen: false })).toEqual(["When to follow up"]);
      expect(stepsMissing({ ...ready, reached, hasLocation: false, hasType: false, contactOk: false })).toEqual([]);
    }
  });
});

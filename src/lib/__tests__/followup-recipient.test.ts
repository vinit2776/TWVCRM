import { describe, it, expect } from "vitest";
import { followUpRecipient } from "../followup-recipient";

const priya = { id: "p", email: "priya@x.test", phone: "+911", full_name: "Priya" };
const arjun = { id: "a", email: "arjun@x.test", phone: "+912", full_name: "Arjun" };

describe("followUpRecipient", () => {
  it("goes to the handler once the lead has been reassigned", () => {
    expect(followUpRecipient({ creator: priya, lead: { assigned_user: arjun } })).toBe(arjun);
  });

  it("falls back to the person who set the follow-up when nobody handles the lead", () => {
    expect(followUpRecipient({ creator: priya, lead: { assigned_user: null } })).toBe(priya);
    expect(followUpRecipient({ creator: priya, lead: null })).toBe(priya);
  });

  it("falls back when the handler has no way to be reached", () => {
    expect(followUpRecipient({ creator: priya, lead: { assigned_user: { id: "a" } } })).toBe(priya);
  });

  it("is null when there is nobody at all", () => {
    expect(followUpRecipient({})).toBeNull();
  });
});
